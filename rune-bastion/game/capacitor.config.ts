import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.runebastion.game',
  appName: 'Rune Bastion',
  webDir: 'dist',
  backgroundColor: '#2b2f55',
  android: { allowMixedContent: false, webContentsDebuggingEnabled: false },
  ios: { contentInset: 'never', scrollEnabled: false },
  plugins: {
    // Transactions are finished by the game only after the reward is delivered and saved.
    NativePurchases: { autoFinishTransactions: false },
  },
};

export default config;
