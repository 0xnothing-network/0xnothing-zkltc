package xyz.zeroxnothing.wallet;

import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

// Tracked source: scripts/configure-android.ts installs it over the generated
// shell's MainActivity with the package set to appId. Edit it here, not in android/.
// Keep the first line as it is: the script recognises an older install by it.
public class MainActivity extends BridgeActivity {

    // The page may define window.__walletBack(), returning true when it handled
    // Back (closed a sheet, went to Home). Anything else counts as not handled.
    private static final String WALLET_BACK =
        "(function(){try{return typeof window.__walletBack==='function'&&window.__walletBack()===true;}catch(e){return false;}})()";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // The seed phrase, private keys and balances must not reach screenshots,
        // screen recording, casting or the Recents thumbnail.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false);

        // BridgeActivity leaves Back to the default, which finishes the activity on
        // Android 7-11 and destroys the WebView with the in-memory session key.
        // Let the page handle it first; otherwise background the task, never finish.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = bridge == null ? null : bridge.getWebView();
                if (webView == null) {
                    moveTaskToBack(true);
                    return;
                }
                webView.evaluateJavascript(WALLET_BACK, (result) -> {
                    if (!"true".equals(result)) moveTaskToBack(true);
                });
            }
        });
    }
}
