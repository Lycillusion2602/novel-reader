package com.yuanchuan.yandu;

import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 全屏沉浸：把**系统状态栏和系统导航栏一起藏掉**，让阅读界面铺满整块屏幕。
 *
 * 为什么自己写：@capacitor/status-bar 只管状态栏，底部的系统导航栏它碰不到，
 * 而她要的是"无任何系统 UI 残留" —— 两条都得藏。
 * 顺带把系统栏的真实高度量出来给 JS（insets），
 * 这样顶栏/底栏能贴着物理边界排，不用再写死 46px / 26px 那种猜的数。
 *
 * 行为用的是 BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE：
 * 藏了之后从屏幕边缘滑一下能临时唤出系统栏，滑完自己收回去 —— 不然用户会以为被锁死。
 */
@CapacitorPlugin(name = "Immersive")
public class ImmersivePlugin extends Plugin {

    @PluginMethod
    public void hide(PluginCall call) {
        getActivity().runOnUiThread(new Runnable() {
            @Override public void run() { setBars(false); call.resolve(); }
        });
    }

    @PluginMethod
    public void show(PluginCall call) {
        getActivity().runOnUiThread(new Runnable() {
            @Override public void run() { setBars(true); call.resolve(); }
        });
    }

    /** 量系统栏的真实高度（px）。藏起来的时候返回 0。 */
    @PluginMethod
    public void insets(PluginCall call) {
        getActivity().runOnUiThread(new Runnable() {
            @Override public void run() {
                int top = 0, bottom = 0;
                WindowInsets in = getActivity().getWindow().getDecorView().getRootWindowInsets();
                if (in != null) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        android.graphics.Insets b =
                            in.getInsets(WindowInsets.Type.systemBars());
                        /* 系统栏正显示着才算数；藏起来的时候这里会给 0 */
                        boolean shown = in.isVisible(WindowInsets.Type.systemBars());
                        if (shown) { top = b.top; bottom = b.bottom; }
                    } else {
                        top = in.getStableInsetTop();
                        bottom = in.getStableInsetBottom();
                    }
                }
                JSObject r = new JSObject();
                r.put("top", top);
                r.put("bottom", bottom);
                call.resolve(r);
            }
        });
    }

    private void setBars(boolean visible) {
        Window w = getActivity().getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = w.getInsetsController();
            if (c == null) return;
            if (visible) {
                c.show(WindowInsets.Type.systemBars());
            } else {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            View decor = w.getDecorView();
            if (visible) {
                decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
            } else {
                decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION);
            }
        }
    }
}
