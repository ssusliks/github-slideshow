package com.runebastion.game;

import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.os.PowerManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.MessageDigest;

/**
 * Small native helper for the game:
 *  - getInfo():    SHA-256 of the APK signing certificate, installer package and debuggable flag,
 *                  used by the "modified build" check (online features are restricted, never gameplay).
 *  - getThermal(): PowerManager thermal status so the game can lower effects when the device is hot.
 */
@CapacitorPlugin(name = "AppIntegrity")
public class AppIntegrityPlugin extends Plugin {

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject out = new JSObject();
        try {
            PackageManager pm = getContext().getPackageManager();
            String pkg = getContext().getPackageName();
            Signature[] signatures;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                PackageInfo info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES);
                signatures = info.signingInfo.hasMultipleSigners()
                        ? info.signingInfo.getApkContentsSigners()
                        : info.signingInfo.getSigningCertificateHistory();
            } else {
                @SuppressWarnings("deprecation")
                PackageInfo info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES);
                signatures = info.signatures;
            }
            String hash = "";
            if (signatures != null && signatures.length > 0) {
                byte[] digest = MessageDigest.getInstance("SHA-256").digest(signatures[0].toByteArray());
                StringBuilder sb = new StringBuilder();
                for (byte b : digest) sb.append(String.format("%02x", b));
                hash = sb.toString();
            }
            String installer = "";
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    String name = pm.getInstallSourceInfo(pkg).getInstallingPackageName();
                    installer = name == null ? "" : name;
                } else {
                    @SuppressWarnings("deprecation")
                    String name = pm.getInstallerPackageName(pkg);
                    installer = name == null ? "" : name;
                }
            } catch (Exception ignored) {
                // installer is informational only
            }
            out.put("signature", hash);
            out.put("installer", installer);
            out.put("debuggable", (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("integrity info unavailable", e);
        }
    }

    @PluginMethod
    public void getThermal(PluginCall call) {
        JSObject out = new JSObject();
        int status = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            PowerManager pm = (PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
            if (pm != null) status = pm.getCurrentThermalStatus();
        }
        out.put("status", status);
        call.resolve(out);
    }
}
