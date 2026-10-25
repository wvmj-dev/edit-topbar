import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ANIMATION_TIME = 200;
// Same pressure as GNOME's hot corner.
const PRESSURE_THRESHOLD = 100;
const PRESSURE_TIMEOUT = 1000;

/**
 * Slides the whole top bar out of the screen and back, and gives its space
 * to the windows while it can hide.
 */
export class TopBarHider {
    /**
     * @param {Function} onPressure called when the pointer pushes the top edge
     */
    constructor(onPressure) {
        this._onPressure = onPressure;
        this._panelBox = Main.layoutManager.panelBox;
        this._struts = true;
        this._visible = true;
        this._pressure = null;
        this._barrier = null;
        this._searchPadding = false;

        Main.layoutManager.connectObject('monitors-changed', () => {
            if (this._pressure)
                this._createBarrier();
            if (!this._visible)
                this._panelBox.translation_y = -this._panelBox.height;
        }, this);
    }

    destroy() {
        Main.layoutManager.disconnectObject(this);
        this.setPressure(false);
        this.setSearchPadding(false);
        this._panelBox.remove_transition('translation-y');
        this._panelBox.translation_y = 0;
        this.setStruts(true);
    }

    /**
     * Whether the top bar reserves its space at the top of the screen.
     * Without it, maximized windows and the overview take the whole height.
     *
     * @param {boolean} struts reserve the space
     */
    setStruts(struts) {
        if (struts === this._struts)
            return;
        this._struts = struts;
        this._track();
    }

    _track() {
        // Same parameters GNOME Shell uses when it adds the top bar.
        Main.layoutManager.untrackChrome(this._panelBox);
        Main.layoutManager.trackChrome(this._panelBox, {
            affectsStruts: this._struts,
            trackFullscreen: true,
        });
    }

    /**
     * @param {boolean} visible show or hide the top bar
     * @param {boolean} animate slide; a menu opening needs the top bar in
     *   place at once, before the menu is positioned
     */
    setVisible(visible, animate) {
        if (visible === this._visible)
            return;
        this._visible = visible;
        const y = visible ? 0 : -this._panelBox.height;
        this._panelBox.remove_transition('translation-y');
        if (animate) {
            this._panelBox.ease({
                translation_y: y,
                duration: ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                // The reserved space follows the top bar's position, but
                // GNOME only measures it again when the allocation changes.
                onStopped: () => {
                    if (this._struts)
                        this._track();
                },
            });
        } else {
            this._panelBox.translation_y = y;
        }
    }

    /**
     * Without struts the overview starts at the top of the screen, under
     * the top bar; push its search entry down so the top bar does not
     * cover it.
     *
     * @param {boolean} padding add the padding
     */
    setSearchPadding(padding) {
        const searchEntry = Main.overview._overview?._controls?._searchEntryBin;
        if (!searchEntry || padding === this._searchPadding)
            return;
        this._searchPadding = padding;
        const scale = Main.layoutManager.primaryMonitor?.geometry_scale ?? 1;
        searchEntry.set_style(padding ? `padding-top: ${this._panelBox.height / scale}px;` : null);
    }

    /**
     * @param {boolean} enabled watch the pointer pushing the top edge
     */
    setPressure(enabled) {
        if (enabled === Boolean(this._pressure))
            return;
        if (!enabled) {
            this._destroyBarrier();
            this._pressure.destroy();
            this._pressure = null;
            return;
        }
        this._pressure = new Layout.PressureBarrier(PRESSURE_THRESHOLD, PRESSURE_TIMEOUT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        this._pressure.connect('trigger', () => this._onPressure());
        this._createBarrier();
    }

    _createBarrier() {
        this._destroyBarrier();
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        // Lets the pointer move down only, so pushing up builds pressure.
        this._barrier = new Meta.Barrier({
            backend: global.backend,
            x1: monitor.x,
            x2: monitor.x + monitor.width,
            y1: monitor.y,
            y2: monitor.y,
            directions: Meta.BarrierDirection.POSITIVE_Y,
        });
        this._pressure.addBarrier(this._barrier);
    }

    _destroyBarrier() {
        if (!this._barrier)
            return;
        this._pressure.removeBarrier(this._barrier);
        this._barrier.destroy();
        this._barrier = null;
    }

    /**
     * @param {number} x pointer x
     * @param {number} y pointer y
     * @returns {boolean} the point is over the top bar's place, shown or not
     */
    contains(x, y) {
        const monitor = Main.layoutManager.primaryMonitor;
        return Boolean(monitor) && x >= monitor.x && x < monitor.x + monitor.width &&
            y >= monitor.y && y < monitor.y + this._panelBox.height;
    }
}
