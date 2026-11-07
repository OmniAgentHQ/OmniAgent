import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'org.omniagent.WindowBridge';
const OBJECT_PATH = '/org/omniagent/WindowBridge';

const INTERFACE = `
<node>
  <interface name="org.omniagent.WindowBridge">
    <method name="ListWindows">
      <arg type="s" direction="out" name="windows"/>
    </method>
    <method name="GetForeground">
      <arg type="s" direction="out" name="window"/>
    </method>
    <method name="FocusWindow">
      <arg type="s" direction="in" name="handle"/>
      <arg type="b" direction="out" name="focused"/>
    </method>
  </interface>
</node>`;

function describe(window) {
    const rect = window.get_frame_rect();
    return {
        handle: String(window.get_stable_sequence()),
        title: window.get_title() || '',
        processName: window.get_wm_class() || '',
        processId: window.get_pid(),
        bounds: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
        minimized: window.minimized,
        focused: window.has_focus(),
    };
}

function isRealWindow(window) {
    const type = window.get_window_type();
    return type === Meta.WindowType.NORMAL || type === Meta.WindowType.DIALOG;
}

export default class WindowBridgeExtension extends Extension {
    enable() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(INTERFACE, this);
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);
        this._nameId = Gio.bus_own_name(
            Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null, null);
    }

    disable() {
        if (this._nameId) {
            Gio.bus_unown_name(this._nameId);
            this._nameId = null;
        }
        if (this._dbus) {
            this._dbus.unexport();
            this._dbus = null;
        }
    }

    ListWindows() {
        const windows = global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(window => window && isRealWindow(window))
            .map(describe);
        return JSON.stringify({windows});
    }

    GetForeground() {
        const focused = global.display.get_focus_window();
        if (!focused || !isRealWindow(focused)) return JSON.stringify({window: null});
        return JSON.stringify({window: describe(focused)});
    }

    FocusWindow(handle) {
        const wanted = String(handle);
        const target = global.get_window_actors()
            .map(actor => actor.meta_window)
            .find(window => window && String(window.get_stable_sequence()) === wanted);
        if (!target) return false;
        if (target.minimized) target.unminimize();
        target.get_workspace()?.activate(global.get_current_time());
        target.activate(global.get_current_time());
        return target.has_focus();
    }
}
