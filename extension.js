import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BOXES, isVisible, resolveLayout} from './rules.js';

// Prefix of the ids of the icons inside the system menu button.
const STATUS_PREFIX = 'status:';
const SHORTCUT_MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

/**
 * Finds the first icon inside an actor, to show it in the preferences.
 *
 * @param {Clutter.Actor} actor where to look
 * @returns {string} icon name or serialized GIcon, or '' when there is none
 */
function findIcon(actor) {
    const queue = [actor];
    while (queue.length) {
        const current = queue.shift();
        if (current instanceof St.Icon) {
            const icon = current.icon_name || current.gicon?.to_string();
            if (icon)
                return icon;
        }
        queue.push(...current.get_children());
    }
    return '';
}

export default class EditTopBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        const panel = Main.panel;
        this._parents = {left: panel._leftBox, center: panel._centerBox, right: panel._rightBox};

        // id -> {box, actor, label}; rebuilt by every scan.
        this._items = new Map();
        // Original parent and index of every item seen, restored on disable.
        this._homes = new Map();
        // Actors this extension hides -> {natural visibility, signal ids}.
        this._hidden = new Map();
        // Items toggled by their own shortcut: id -> forced visibility.
        this._forced = new Map();
        // Accelerator action -> {id, name} of the per-item shortcuts.
        this._grabs = new Map();
        this._menus = new Set();
        this._knownJson = '';
        this._moved = false;
        this._applying = false;
        this._updateId = 0;
        this._hoverId = 0;
        this._revealId = 0;
        this._windowsId = 0;
        this._state = {
            overview: Main.overview.visible,
            hover: false,
            windows: false,
            revealed: false,
        };

        this._settings.connectObject(
            'changed::layout', () => this._queueUpdate(),
            'changed::rules', () => this._queueUpdate(),
            'changed::shortcuts', () => this._grabShortcuts(),
            this);

        // Indicators come and go as other extensions are enabled, and the
        // panel puts its own items back in place when the session mode changes.
        for (const parent of Object.values(this._parents))
            this._watchChildren(parent);
        const status = panel.statusArea.quickSettings?._indicators;
        if (status)
            this._watchChildren(status);
        Main.sessionMode.connectObject('updated', () => this._queueUpdate(), this);

        Main.overview.connectObject(
            'showing', () => this._setState('overview', true),
            'hiding', () => this._setState('overview', false),
            this);

        this._oldTrackHover = panel.track_hover;
        panel.track_hover = true;
        panel.connectObject('notify::hover', () => this._syncHover(), this);

        global.workspace_manager.connectObject('active-workspace-changed',
            () => this._trackWorkspace(), this);
        this._trackWorkspace();

        Main.wm.addKeybinding('reveal-shortcut', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, SHORTCUT_MODES,
            () => this._toggleReveal());
        global.display.connectObject('accelerator-activated', (_display, action) => {
            const grab = this._grabs.get(action);
            if (grab)
                this._toggleItem(grab.id);
        }, this);
        this._grabShortcuts();

        this._update();
    }

    disable() {
        for (const id of [this._updateId, this._hoverId, this._revealId, this._windowsId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._updateId = this._hoverId = this._revealId = this._windowsId = 0;

        Main.wm.removeKeybinding('reveal-shortcut');
        this._ungrabShortcuts();
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        this._workspace?.disconnectObject(this);
        this._workspace = null;
        Main.overview.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        Main.panel.disconnectObject(this);
        Main.panel.track_hover = this._oldTrackHover;
        for (const menu of this._menus)
            menu.disconnectObject(this);
        this._menus.clear();
        for (const parent of [...Object.values(this._parents), Main.panel.statusArea.quickSettings?._indicators])
            parent?.disconnectObject(this);
        this._settings.disconnectObject(this);

        this._applying = true;
        for (const actor of [...this._hidden.keys()])
            this._setHidden(actor, false);
        this._restoreHomes();
        for (const actor of this._homes.keys())
            actor.disconnectObject(this);
        this._applying = false;

        this._items = this._homes = this._hidden = this._forced = this._grabs = null;
        this._parents = this._settings = null;
    }

    _watchChildren(parent) {
        parent.connectObject(
            'child-added', () => this._queueUpdate(),
            'child-removed', () => this._queueUpdate(),
            this);
    }

    _queueUpdate() {
        if (this._applying || this._updateId)
            return;
        this._updateId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._updateId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- Discovery ----------------------------------------------------------

    /**
     * Lists the items currently in the top bar.
     *
     * @returns {Object<string, string[]>} ids in each box, in display order
     */
    _scan() {
        const panel = Main.panel;
        const roles = new Map();
        for (const [role, indicator] of Object.entries(panel.statusArea)) {
            if (indicator?.container)
                roles.set(indicator.container, {role, indicator});
        }

        this._items.clear();
        const current = {};
        for (const [box, parent] of Object.entries(this._parents)) {
            current[box] = [];
            for (const actor of parent.get_children()) {
                const entry = roles.get(actor);
                if (!entry)
                    continue;
                this._addItem(entry.role, box, actor, entry.indicator.accessible_name || entry.role);
                current[box].push(entry.role);
                this._watchMenu(entry.indicator.menu);
            }
        }

        current.status = [];
        const quickSettings = panel.statusArea.quickSettings;
        const status = quickSettings?._indicators;
        if (status) {
            // Built-in icons are fields of the button (_network, _volumeOutput...).
            const names = new Map();
            for (const [key, value] of Object.entries(quickSettings)) {
                if (value instanceof St.Widget && value.get_parent() === status)
                    names.set(value, key.replace(/^_/, ''));
            }
            for (const actor of status.get_children()) {
                // Icons added by other extensions only have their class name.
                let name = names.get(actor) ?? GObject.type_name(actor.constructor.$gtype);
                let id = STATUS_PREFIX + name;
                for (let n = 2; this._items.has(id); n++)
                    id = `${STATUS_PREFIX}${name}#${n}`;
                name = names.get(actor) ?? actor.constructor.name;
                this._addItem(id, 'status', actor, name);
                current.status.push(id);
            }
        }
        return current;
    }

    _addItem(id, box, actor, label) {
        this._items.set(id, {box, actor, label});
        if (this._homes.has(actor))
            return;
        // An item that appears after others were moved is placed back after
        // the ones that were there from the start.
        const parent = actor.get_parent();
        this._homes.set(actor, {parent, index: parent.get_children().indexOf(actor), late: this._moved});
        actor.connectObject('destroy', () => this._homes?.delete(actor), this);
    }

    _watchMenu(menu) {
        if (!menu || this._menus.has(menu))
            return;
        this._menus.add(menu);
        menu.connectObject(
            'open-state-changed', () => this._syncHover(),
            'destroy', () => this._menus?.delete(menu),
            this);
    }

    // --- Layout and visibility ---------------------------------------------

    _update() {
        this._applying = true;
        try {
            const layout = this._settings.get_value('layout').deepUnpack();
            // Layout reset in the preferences: put everything back first.
            if (!BOXES.some(box => layout[box]?.length))
                this._restoreHomes();
            const current = this._scan();
            const order = resolveLayout(layout, current);
            for (const box of BOXES) {
                const parent = box === 'status'
                    ? Main.panel.statusArea.quickSettings?._indicators
                    : this._parents[box];
                if (parent)
                    this._arrange(parent, order[box].map(id => this._items.get(id).actor));
                for (const id of order[box])
                    this._items.get(id).box = box;
            }
            this._syncVisibility();
            this._publish(order);
        } finally {
            this._applying = false;
        }
    }

    /**
     * Puts `actors` in `parent` in this order, moving only what is out of
     * place. Children that are not top bar items keep their position.
     *
     * @param {Clutter.Actor} parent box that receives the actors
     * @param {Clutter.Actor[]} actors the managed actors of that box, in order
     */
    _arrange(parent, actors) {
        let previous = null;
        for (const actor of actors) {
            const children = parent.get_children();
            const firstOther = children.find(child => actors.includes(child) && child !== actor);
            const outOfPlace = actor.get_parent() !== parent ||
                (previous ? actor.get_previous_sibling() !== previous
                    : firstOther && children.indexOf(firstOther) < children.indexOf(actor));
            this._moved ||= outOfPlace;
            if (actor.get_parent() !== parent) {
                actor.get_parent()?.remove_child(actor);
                if (previous)
                    parent.insert_child_above(actor, previous);
                else
                    parent.insert_child_below(actor, firstOther ?? null);
            } else if (outOfPlace && previous) {
                parent.set_child_above_sibling(actor, previous);
            } else if (outOfPlace) {
                parent.set_child_below_sibling(actor, firstOther);
            }
            previous = actor;
        }
    }

    /**
     * Puts every item back where it was before this extension moved it.
     */
    _restoreHomes() {
        // Nothing moved: leave the order alone, other extensions may have
        // added items since the indexes were recorded.
        if (!this._moved)
            return;
        const byParent = new Map();
        for (const [actor, home] of this._homes) {
            if (!byParent.has(home.parent))
                byParent.set(home.parent, []);
            byParent.get(home.parent).push({actor, ...home});
        }
        for (const [parent, entries] of byParent) {
            entries.sort((a, b) => a.late - b.late || a.index - b.index);
            for (const {actor, index} of entries) {
                if (actor.get_parent() !== parent) {
                    actor.get_parent()?.remove_child(actor);
                    parent.insert_child_at_index(actor, Math.min(index, parent.get_n_children()));
                } else {
                    parent.set_child_at_index(actor, Math.min(index, parent.get_n_children() - 1));
                }
            }
        }
        this._moved = false;
    }

    _syncVisibility() {
        const rules = this._settings.get_value('rules').deepUnpack();
        const wasApplying = this._applying;
        this._applying = true;
        for (const [id, item] of this._items)
            this._setHidden(item.actor, !isVisible(rules[id] ?? 'always', this._state, this._forced.get(id)));
        this._applying = wasApplying;
    }

    /**
     * Hides an actor and keeps it hidden while the indicator that owns it
     * keeps changing its own visibility, or gives the control back.
     *
     * @param {Clutter.Actor} actor container of a panel item or status icon
     * @param {boolean} hidden whether to hide it
     */
    _setHidden(actor, hidden) {
        const entry = this._hidden.get(actor);
        if (hidden && !entry) {
            const state = {natural: actor.visible};
            state.signal = actor.connect('notify::visible', () => {
                if (actor.visible) {
                    state.natural = true;
                    actor.visible = false;
                }
            });
            state.destroy = actor.connect('destroy', () => this._hidden?.delete(actor));
            this._hidden.set(actor, state);
            actor.visible = false;
        } else if (!hidden && entry) {
            actor.disconnect(entry.signal);
            actor.disconnect(entry.destroy);
            this._hidden.delete(actor);
            // Status icons are visible only while one of their icons is.
            if (actor._syncIndicatorsVisible)
                actor._syncIndicatorsVisible();
            else
                actor.visible = entry.natural;
        }
    }

    /**
     * Saves the items found, so the preferences can list them.
     *
     * @param {Object<string, string[]>} order ids in each box
     */
    _publish(order) {
        const known = BOXES.flatMap(box => order[box].map(id => {
            const {actor, label} = this._items.get(id);
            return [id, box, label, findIcon(actor)];
        }));
        const json = JSON.stringify(known);
        if (json === this._knownJson)
            return;
        this._knownJson = json;
        this._settings.set_value('known-items', new GLib.Variant('a(ssss)', known));
    }

    // --- Conditions ---------------------------------------------------------

    _setState(key, value) {
        if (this._state[key] === value)
            return;
        this._state[key] = value;
        this._syncVisibility();
    }

    // The pointer is over the top bar, or in one of its open menus.
    _isHovered() {
        return Main.panel.hover || [...this._menus].some(menu => menu.isOpen);
    }

    _syncHover() {
        const active = this._isHovered();
        if (this._hoverId) {
            GLib.source_remove(this._hoverId);
            this._hoverId = 0;
        }
        const delay = this._settings.get_int('hover-delay');
        if (active || delay === 0) {
            this._setState('hover', active);
            return;
        }
        this._hoverId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._hoverId = 0;
            this._setState('hover', this._isHovered());
            return GLib.SOURCE_REMOVE;
        });
    }

    _trackWorkspace() {
        this._workspace?.disconnectObject(this);
        this._workspace = global.workspace_manager.get_active_workspace();
        // A new window is not fully set up when window-added fires.
        const sync = () => {
            if (this._windowsId)
                return;
            this._windowsId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._windowsId = 0;
                this._syncWindows();
                return GLib.SOURCE_REMOVE;
            });
        };
        this._workspace.connectObject(
            'window-added', sync,
            'window-removed', sync,
            this);
        this._syncWindows();
    }

    _syncWindows() {
        const windows = this._workspace.list_windows().some(window =>
            !window.skip_taskbar && window.get_window_type() !== Meta.WindowType.DESKTOP);
        this._setState('windows', windows);
    }

    // --- Shortcuts ----------------------------------------------------------

    _toggleReveal() {
        if (this._revealId) {
            GLib.source_remove(this._revealId);
            this._revealId = 0;
        }
        const revealed = !this._state.revealed;
        this._setState('revealed', revealed);
        const timeout = this._settings.get_int('reveal-timeout');
        if (revealed && timeout > 0) {
            this._revealId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeout, () => {
                this._revealId = 0;
                this._setState('revealed', false);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /**
     * Shows a hidden item or hides a shown one; the next press returns it to
     * its rule.
     *
     * @param {string} id item id
     */
    _toggleItem(id) {
        if (this._forced.has(id)) {
            this._forced.delete(id);
        } else {
            const rules = this._settings.get_value('rules').deepUnpack();
            this._forced.set(id, !isVisible(rules[id] ?? 'always', this._state));
        }
        this._syncVisibility();
    }

    _grabShortcuts() {
        this._ungrabShortcuts();
        const shortcuts = this._settings.get_value('shortcuts').deepUnpack();
        for (const [id, accelerator] of Object.entries(shortcuts)) {
            if (!accelerator)
                continue;
            const action = global.display.grab_accelerator(accelerator, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT);
            if (action === Meta.KeyBindingAction.NONE) {
                console.warn(`${this.uuid}: could not grab ${accelerator} for ${id}; it may be in use`);
                continue;
            }
            const name = Meta.external_binding_name_for_action(action);
            Main.wm.allowKeybinding(name, SHORTCUT_MODES);
            this._grabs.set(action, {id, name});
        }
    }

    _ungrabShortcuts() {
        for (const [action, {name}] of this._grabs) {
            global.display.ungrab_accelerator(action);
            Main.wm.allowKeybinding(name, Shell.ActionMode.NONE);
        }
        this._grabs.clear();
    }
}
