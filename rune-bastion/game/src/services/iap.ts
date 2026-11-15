import { CONFIG } from '../config';
import { IAP_PRODUCTS } from '../data/meta';
import type { Game } from '../meta/game';
import type { Breaker } from './log';
import { withTimeout } from './log';
import { api, cloudConfigured } from './net';
import { isNative, platformName } from './platform';
import type { KV } from './storage';

/**
 * In-app purchases. Flow for every transaction:
 *   store purchase → written to the pending journal → verified (server when configured) →
 *   delivered through Game.applyPurchase (idempotent by transaction id) → finished/consumed in
 *   the store → removed from the journal.
 * A crash at any point is recovered by `recover()` on the next start; nothing is granted twice
 * and nothing paid is lost.
 */
export interface StoreTx { transactionId: string; productId: string; platform: 'android' | 'ios' | 'sandbox'; purchaseToken?: string; receipt?: string }
export interface BillingProvider {
  readonly name: string;
  init(): Promise<boolean>;
  prices(ids: string[]): Promise<Record<string, string>>;
  purchase(productId: string): Promise<StoreTx | null>;
  /** transactions the store still considers undelivered / owned. */
  outstanding(): Promise<StoreTx[]>;
  finish(tx: StoreTx, consumable: boolean): Promise<void>;
}
export type BuyResult = { ok: true; granted: boolean } | { ok: false; reason: 'cancelled' | 'unavailable' | 'verify_failed' | 'pending' | 'error' };

/** Google Play Billing / StoreKit 2 through @capgo/native-purchases. */
export class NativeBilling implements BillingProvider {
  readonly name = 'native';
  private mod: typeof import('@capgo/native-purchases') | null = null;
  async init(): Promise<boolean> {
    this.mod = await import('@capgo/native-purchases');
    // Transactions are finished manually, only after the reward has been delivered and saved.
    await this.mod.NativePurchases.configure({ autoFinishTransactions: false });
    return (await this.mod.NativePurchases.isBillingSupported()).isBillingSupported;
  }
  private toTx(t: { transactionId: string; productIdentifier: string; purchaseToken?: string; receipt?: string; jwsRepresentation?: string; orderId?: string }): StoreTx {
    const platform = platformName() === 'ios' ? 'ios' : 'android';
    return { transactionId: platform === 'android' ? t.orderId || t.transactionId : t.transactionId, productId: t.productIdentifier, platform, purchaseToken: t.purchaseToken, receipt: t.jwsRepresentation ?? t.receipt };
  }
  async prices(ids: string[]): Promise<Record<string, string>> {
    const m = this.mod!;
    const { products } = await m.NativePurchases.getProducts({ productIdentifiers: ids, productType: m.PURCHASE_TYPE.INAPP });
    return Object.fromEntries(products.map((p) => [p.identifier, p.priceString]));
  }
  async purchase(productId: string): Promise<StoreTx | null> {
    const m = this.mod!;
    try {
      const t = await m.NativePurchases.purchaseProduct({ productIdentifier: productId, productType: m.PURCHASE_TYPE.INAPP, quantity: 1, isConsumable: false, autoAcknowledgePurchases: false });
      return t?.transactionId ? this.toTx(t) : null;
    } catch (e) {
      if (/cancel/i.test(String((e as any)?.message ?? e))) return null;
      throw e;
    }
  }
  async outstanding(): Promise<StoreTx[]> {
    const m = this.mod!;
    if (platformName() === 'ios') {
      const { transactions } = await m.NativePurchases.getUnfinishedTransactions();
      const owned = await m.NativePurchases.getPurchases({ productType: m.PURCHASE_TYPE.INAPP, onlyCurrentEntitlements: true });
      return [...transactions, ...owned.purchases].map((t) => this.toTx(t));
    }
    const { purchases } = await m.NativePurchases.getPurchases({ productType: m.PURCHASE_TYPE.INAPP });
    return purchases.filter((p) => !p.purchaseState || p.purchaseState === 'PURCHASED' || p.purchaseState === '1').map((t) => this.toTx(t));
  }
  async finish(tx: StoreTx, consumable: boolean): Promise<void> {
    const m = this.mod!;
    if (tx.platform === 'ios') await m.NativePurchases.finishTransaction({ transactionId: tx.transactionId });
    else if (tx.purchaseToken) {
      if (consumable) await m.NativePurchases.consumePurchase({ purchaseToken: tx.purchaseToken });
      else await m.NativePurchases.acknowledgePurchase({ purchaseToken: tx.purchaseToken });
    }
  }
}

/**
 * Sandbox store for development builds and automated tests: a confirmation sheet instead of a
 * real payment. Transactions run through the same journal / verification / delivery path.
 */
export class SandboxBilling implements BillingProvider {
  readonly name = 'sandbox';
  private open: StoreTx[] = [];
  constructor(private confirm: (productId: string, price: string) => Promise<boolean>, private mkId: () => string) {}
  async init(): Promise<boolean> { return true; }
  async prices(ids: string[]): Promise<Record<string, string>> {
    return Object.fromEntries(ids.map((id) => [id, IAP_PRODUCTS.find((p) => p.id === id)?.price ?? '']));
  }
  async purchase(productId: string): Promise<StoreTx | null> {
    const price = IAP_PRODUCTS.find((p) => p.id === productId)?.price ?? '';
    if (!(await this.confirm(productId, price))) return null;
    const tx: StoreTx = { transactionId: `sbx-${this.mkId()}`, productId, platform: 'sandbox', purchaseToken: `sandbox:${productId}` };
    this.open.push(tx);
    return tx;
  }
  async outstanding(): Promise<StoreTx[]> { return this.open.slice(); }
  async finish(tx: StoreTx): Promise<void> { this.open = this.open.filter((t) => t.transactionId !== tx.transactionId); }
}

export class PurchaseService {
  prices: Record<string, string> = {};
  ready = false;
  private busy = false;

  constructor(
    private provider: BillingProvider | null, private game: () => Game, private kv: KV, private breaker: Breaker,
    private token: () => string | undefined, private log: (kind: string, msg: unknown) => void, private onDelivered: () => void,
  ) {}

  get available(): boolean {
    return !!this.provider && this.ready && !this.breaker.open;
  }
  get providerName(): string {
    return this.provider?.name ?? 'none';
  }
  priceOf(id: string): string {
    return this.prices[id] ?? IAP_PRODUCTS.find((p) => p.id === id)?.price ?? '';
  }

  async init(): Promise<void> {
    if (!this.provider) return;
    try {
      this.ready = await withTimeout(this.provider.init(), 10000, 'iap.init');
      if (this.ready) {
        this.prices = await withTimeout(this.provider.prices(IAP_PRODUCTS.map((p) => p.id)), 10000, 'iap.prices').catch(() => ({}));
        await this.recover();
      }
    } catch (e) {
      this.log('iap_init', e);
      this.breaker.fail();
    }
  }

  private journal(): StoreTx[] {
    try { const v = JSON.parse(this.kv.get('pending') ?? '[]'); return Array.isArray(v) ? v.filter((t) => t && typeof t.transactionId === 'string' && typeof t.productId === 'string') : []; } catch { return []; }
  }
  private setJournal(list: StoreTx[]): void {
    this.kv.set('pending', JSON.stringify(list.slice(-30)));
  }

  /** 'ok' = genuine, 'bad' = rejected by the store/server, 'retry' = could not reach the verifier. */
  private async verify(tx: StoreTx): Promise<'ok' | 'bad' | 'retry'> {
    if (!IAP_PRODUCTS.some((p) => p.id === tx.productId)) return 'bad';
    // Sandbox transactions only exist in development builds; release builds always refuse them.
    if (tx.platform === 'sandbox' && !CONFIG.dev) return 'bad';
    // No backend deployed: rely on the platform store's own validation (or the dev sandbox).
    if (!cloudConfigured()) return 'ok';
    const r = await api('POST', '/v1/iap/verify', { platform: tx.platform, productId: tx.productId, transactionId: tx.transactionId, purchaseToken: tx.purchaseToken, receipt: tx.receipt }, this.token());
    if (r.ok && r.data?.valid === true) return 'ok';
    if (r.status === 400 || r.status === 402 || r.status === 409 || (r.ok && r.data?.valid === false)) return 'bad';
    return 'retry';
  }

  private async deliver(tx: StoreTx): Promise<'granted' | 'duplicate' | 'bad' | 'retry'> {
    const v = await this.verify(tx);
    if (v !== 'ok') return v;
    const prod = IAP_PRODUCTS.find((p) => p.id === tx.productId)!;
    const res = this.game().applyPurchase(tx.productId, tx.transactionId);
    if (!res.ok) return 'bad';
    this.onDelivered(); // flush the save BEFORE telling the store the purchase is finished
    try { await this.provider!.finish(tx, prod.type === 'consumable'); } catch (e) { this.log('iap_finish', e); }
    return res.granted ? 'granted' : 'duplicate';
  }

  async buy(productId: string): Promise<BuyResult> {
    if (!this.available || this.busy) return { ok: false, reason: 'unavailable' };
    const prod = IAP_PRODUCTS.find((p) => p.id === productId);
    if (!prod) return { ok: false, reason: 'error' };
    this.busy = true;
    try {
      const tx = await withTimeout(this.provider!.purchase(productId), 300000, 'iap.purchase');
      if (!tx) return { ok: false, reason: 'cancelled' };
      this.setJournal([...this.journal().filter((t) => t.transactionId !== tx.transactionId), tx]);
      const r = await this.deliver(tx);
      if (r === 'retry') return { ok: false, reason: 'pending' };
      this.setJournal(this.journal().filter((t) => t.transactionId !== tx.transactionId));
      this.breaker.ok();
      if (r === 'bad') { this.log('iap_rejected', `${tx.productId} ${tx.transactionId}`); return { ok: false, reason: 'verify_failed' }; }
      return { ok: true, granted: r === 'granted' };
    } catch (e) {
      this.log('iap_buy', e);
      this.breaker.fail();
      return { ok: false, reason: 'error' };
    } finally {
      this.busy = false;
    }
  }

  /** Delivers everything that was paid for but not yet granted (journal + store queue). Also "Restore purchases". */
  async recover(): Promise<number> {
    if (!this.provider || !this.ready) return 0;
    let delivered = 0;
    try {
      const store = await withTimeout(this.provider.outstanding(), 15000, 'iap.outstanding').catch(() => [] as StoreTx[]);
      const seen = new Set<string>();
      const all = [...this.journal(), ...store].filter((t) => (seen.has(t.transactionId) ? false : (seen.add(t.transactionId), true)));
      let journal = this.journal();
      for (const tx of all) {
        const r = await this.deliver(tx);
        if (r === 'granted') delivered++;
        if (r !== 'retry') journal = journal.filter((t) => t.transactionId !== tx.transactionId);
      }
      this.setJournal(journal);
    } catch (e) {
      this.log('iap_recover', e);
    }
    return delivered;
  }
}

export function createBillingProvider(confirm: (productId: string, price: string) => Promise<boolean>, mkId: () => string): BillingProvider | null {
  if (isNative()) return new NativeBilling();
  return CONFIG.dev ? new SandboxBilling(confirm, mkId) : null;
}
