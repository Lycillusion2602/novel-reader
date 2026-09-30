package com.yuanchuan.yandu;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * 注册自己写的全屏插件（ImmersivePlugin）：把系统状态栏和导航栏一起藏掉。
     * ⚠️ registerPlugin 必须在 super.onCreate 之前 —— 顺序反了插件就不生效，
     *    JS 那边调 Capacitor.Plugins.Immersive 会拿到 undefined（静默失效，很难查）。
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ImmersivePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
