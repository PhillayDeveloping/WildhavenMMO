package com.wildhaven;

public final class MainActivity extends BaseMainActivity {
    @Override
    protected void registerDistributionPlugins() {
        // No distribution-specific plugins. The hook exists because BaseMainActivity
        // declares it for flavors that do register one; this build registers nothing.
    }
}
