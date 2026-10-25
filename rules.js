// Visibility rules and layout merging. No GNOME Shell imports, so this module
// runs in the shell, in the preferences and in tests/unit.js.

// Boxes of the top bar, in screen order. "status" is the row of icons inside
// the system menu button (network, volume, battery...): its items can be
// reordered and hidden, but not moved out of it.
export const BOXES = ['left', 'center', 'right', 'status'];
export const PANEL_BOXES = ['left', 'center', 'right'];

// When an item is shown. "always" leaves the item alone.
export const RULES = [
    'always',
    'never',
    'overview',
    'desktop',
    'hover',
    'empty-workspace',
    'windows',
];

/**
 * Whether an item should be visible.
 *
 * @param {string} rule one of RULES; unknown values count as "always"
 * @param {object} state current shell state
 * @param {boolean} state.overview the overview is showing
 * @param {boolean} state.hover the pointer is over the top bar, or one of its menus is open
 * @param {boolean} state.windows the active workspace has windows
 * @param {boolean} state.revealed the "reveal hidden items" shortcut is active
 * @param {boolean} [forced] set by the item's own shortcut; wins over everything
 * @returns {boolean}
 */
export function isVisible(rule, state, forced) {
    if (forced !== undefined)
        return forced;
    if (state.revealed)
        return true;
    switch (rule) {
    case 'never': return false;
    case 'overview': return state.overview;
    case 'desktop': return !state.overview;
    case 'hover': return state.hover;
    case 'empty-workspace': return !state.windows;
    case 'windows': return state.windows;
    default: return true;
    }
}

// When the whole top bar is shown. "always" leaves it alone.
export const PANEL_MODES = ['always', 'never', 'auto'];

// Situations that hide the top bar in "auto" mode; any of them is enough.
export const PANEL_CONDITIONS = ['overlap', 'maximized', 'windows'];

/**
 * Whether the whole top bar should be visible.
 *
 * @param {object} options top bar settings
 * @param {string} options.mode one of PANEL_MODES; unknown values count as "always"
 * @param {string[]} options.hideWhen conditions of "auto" mode, from PANEL_CONDITIONS
 * @param {boolean} options.showInOverview show the top bar while the overview is open
 * @param {object} state current shell state
 * @param {boolean} state.overview the overview is showing
 * @param {boolean} state.revealed the "reveal hidden items" shortcut is active
 * @param {boolean} state.pointer the pointer pushed the top edge and is still on the top bar
 * @param {boolean} state.menuOpen a menu of the top bar is open
 * @param {boolean} state.overlap a window touches the top bar
 * @param {boolean} state.maximized a window is maximized on the top bar's monitor
 * @param {boolean} state.windows the active workspace has windows
 * @param {boolean} [forced] set by the top bar shortcut; wins over everything
 * @returns {boolean}
 */
export function isPanelVisible({mode, hideWhen, showInOverview}, state, forced) {
    if (forced !== undefined)
        return forced;
    if (!PANEL_MODES.includes(mode) || mode === 'always')
        return true;
    if (state.revealed || state.pointer || state.menuOpen)
        return true;
    if (state.overview)
        return showInOverview;
    if (mode === 'never')
        return false;
    return !hideWhen.some(condition => PANEL_CONDITIONS.includes(condition) && state[condition]);
}

/**
 * Computes where every item goes.
 *
 * `layout` is the saved arrangement ({box: [ids]}), which may name items that
 * do not exist right now (from a disabled extension) and miss items that
 * appeared after it was saved. Missing items stay in their current box, right
 * after the item that precedes them there, so a new indicator shows up where
 * its extension put it.
 *
 * @param {Object<string, string[]>} layout saved arrangement; empty means "not customized"
 * @param {Object<string, string[]>} current ids in each box, in their current order
 * @returns {Object<string, string[]>} the order to apply to each box
 */
export function resolveLayout(layout, current) {
    const customized = BOXES.some(box => layout[box]?.length);
    const result = {};
    if (!customized) {
        for (const box of BOXES)
            result[box] = [...current[box] ?? []];
        return result;
    }

    const present = new Set(BOXES.flatMap(box => current[box] ?? []));
    const statusIds = new Set(current.status ?? []);
    const placed = new Set();
    for (const box of BOXES) {
        // An item never crosses between the panel and the status icons.
        result[box] = (layout[box] ?? []).filter(id =>
            present.has(id) && !placed.has(id) && statusIds.has(id) === (box === 'status'));
        result[box].forEach(id => placed.add(id));
    }

    for (const box of BOXES) {
        const ids = current[box] ?? [];
        ids.forEach((id, i) => {
            if (placed.has(id))
                return;
            const before = ids.slice(0, i).reverse().find(other => result[box].includes(other));
            const at = before === undefined ? 0 : result[box].indexOf(before) + 1;
            result[box].splice(at, 0, id);
            placed.add(id);
        });
    }
    return result;
}

/**
 * Moves an item inside the arrangement shown in the preferences.
 *
 * @param {Object<string, string[]>} layout full arrangement ({box: [ids]})
 * @param {string} id item to move
 * @param {string} box target box
 * @param {number} index target position in that box; clamped
 * @returns {Object<string, string[]>} a new arrangement; the input is not changed
 */
export function moveItem(layout, id, box, index) {
    const result = {};
    for (const name of BOXES)
        result[name] = (layout[name] ?? []).filter(other => other !== id);
    const target = result[box];
    target.splice(Math.max(0, Math.min(index, target.length)), 0, id);
    return result;
}

/**
 * Builds the layout to save from the arrangement shown in the preferences,
 * keeping items that are not present right now (an indicator of a disabled
 * extension) after the same neighbour as before.
 *
 * @param {Object<string, string[]>} shown arrangement of the present items
 * @param {Object<string, string[]>} saved previously saved layout
 * @returns {Object<string, string[]>}
 */
export function mergeLayout(shown, saved) {
    const present = new Set(BOXES.flatMap(box => shown[box] ?? []));
    const result = {};
    for (const box of BOXES) {
        result[box] = [...shown[box] ?? []];
        const old = saved[box] ?? [];
        old.forEach((id, i) => {
            if (present.has(id))
                return;
            const before = old.slice(0, i).reverse().find(other => result[box].includes(other));
            const at = before === undefined ? 0 : result[box].indexOf(before) + 1;
            result[box].splice(at, 0, id);
        });
    }
    return result;
}
