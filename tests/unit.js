// Unit tests for the pure module. Run with: gjs -m tests/unit.js
// (or ./build.sh unit). No GNOME Shell needed.
import {BOXES, PANEL_CONDITIONS, RULES, isPanelVisible, isVisible, mergeLayout, moveItem, resolveLayout} from '../rules.js';

let failures = 0;
let count = 0;
function check(name, condition, detail = '') {
    count++;
    if (!condition) {
        failures++;
        print(`FAIL ${name} ${detail}`);
    }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const CURRENT = {
    left: ['activities'],
    center: ['dateMenu'],
    right: ['screenRecording', 'a11y', 'keyboard', 'quickSettings'],
    status: ['status:network', 'status:volumeOutput', 'status:system'],
};

// --- isVisible --------------------------------------------------------------
const idle = {overview: false, hover: false, windows: true, revealed: false};
check('always', isVisible('always', idle));
check('unknown rule is always', isVisible('nonsense', idle));
check('never', !isVisible('never', idle));
check('overview hidden on desktop', !isVisible('overview', idle));
check('overview shown in overview', isVisible('overview', {...idle, overview: true}));
check('desktop', isVisible('desktop', idle) && !isVisible('desktop', {...idle, overview: true}));
check('hover', !isVisible('hover', idle) && isVisible('hover', {...idle, hover: true}));
check('empty-workspace', !isVisible('empty-workspace', idle) &&
    isVisible('empty-workspace', {...idle, windows: false}));
check('windows', isVisible('windows', idle) && !isVisible('windows', {...idle, windows: false}));
for (const rule of RULES)
    check(`revealed shows ${rule}`, isVisible(rule, {...idle, revealed: true}));
check('forced hide wins over always', !isVisible('always', idle, false));
check('forced show wins over never', isVisible('never', idle, true));
check('forced hide wins over reveal', !isVisible('never', {...idle, revealed: true}, false));

// --- isPanelVisible ---------------------------------------------------------
const calm = {overview: false, revealed: false, pointer: false, menuOpen: false,
    overlap: false, maximized: false, windows: false};
const busy = {...calm, overlap: true, maximized: true, windows: true};
const auto = {mode: 'auto', hideWhen: ['overlap'], showInOverview: true};
check('always ignores everything', isPanelVisible({...auto, mode: 'always'}, {...busy, overview: true}) &&
    isPanelVisible({...auto, mode: 'always', showInOverview: false}, {...calm, overview: true}));
check('unknown mode is always', isPanelVisible({...auto, mode: 'nonsense'}, busy));
check('never hides', !isPanelVisible({...auto, mode: 'never'}, calm));
check('auto shows without its condition', isPanelVisible(auto, {...calm, maximized: true, windows: true}));
check('auto hides with its condition', !isPanelVisible(auto, {...calm, overlap: true}));
for (const condition of PANEL_CONDITIONS) {
    check(`auto ${condition}`, !isPanelVisible({...auto, hideWhen: [condition]}, {...calm, [condition]: true}) &&
        isPanelVisible({...auto, hideWhen: [condition]}, calm));
}
check('any condition hides', !isPanelVisible({...auto, hideWhen: ['windows', 'maximized']}, {...calm, maximized: true}));
check('no condition never hides', isPanelVisible({...auto, hideWhen: []}, busy));
check('unknown condition is ignored', isPanelVisible({...auto, hideWhen: ['nonsense']}, {...calm, nonsense: true}));
check('overview shows', isPanelVisible({...auto, mode: 'never'}, {...calm, overview: true}));
check('overview can hide', !isPanelVisible({...auto, mode: 'never', showInOverview: false}, {...calm, overview: true}) &&
    !isPanelVisible({...auto, showInOverview: false}, {...calm, overview: true}));
for (const reason of ['revealed', 'pointer', 'menuOpen']) {
    check(`${reason} shows`, isPanelVisible({...auto, mode: 'never', showInOverview: false},
        {...busy, overview: true, [reason]: true}));
}
check('forced hide wins in always', !isPanelVisible({...auto, mode: 'always'}, calm, false));
check('forced show wins in never', isPanelVisible({...auto, mode: 'never'}, calm, true));
check('forced hide wins over a menu', !isPanelVisible(auto, {...calm, menuOpen: true}, false));

// --- resolveLayout ----------------------------------------------------------
check('empty layout keeps the current order', same(resolveLayout({}, CURRENT), CURRENT));
check('empty lists keep the current order',
    same(resolveLayout({left: [], right: []}, CURRENT), CURRENT));

let order = resolveLayout({
    left: ['activities', 'dateMenu'],
    center: [],
    right: ['quickSettings', 'keyboard', 'a11y', 'screenRecording'],
    status: ['status:system', 'status:network', 'status:volumeOutput'],
}, CURRENT);
check('moves the clock left', same(order.left, ['activities', 'dateMenu']));
check('center becomes empty', same(order.center, []));
check('reverses the right box', same(order.right, ['quickSettings', 'keyboard', 'a11y', 'screenRecording']));
check('reorders the status icons', same(order.status, ['status:system', 'status:network', 'status:volumeOutput']));

order = resolveLayout({right: ['quickSettings', 'a11y']}, CURRENT);
check('unlisted items follow their previous neighbour',
    same(order.right, ['screenRecording', 'quickSettings', 'a11y', 'keyboard']), JSON.stringify(order.right));
check('boxes not in the layout keep their items', same(order.left, ['activities']) && same(order.center, ['dateMenu']));

order = resolveLayout({right: ['ghost@ext', 'quickSettings']}, CURRENT);
check('absent items are skipped', !order.right.includes('ghost@ext'));

order = resolveLayout({left: ['status:network', 'activities'], status: ['quickSettings']}, CURRENT);
check('status icons do not leave the system menu', order.status.includes('status:network') &&
    !order.left.includes('status:network'));
check('panel items do not enter the system menu', !order.status.includes('quickSettings') &&
    order.right.includes('quickSettings'));

order = resolveLayout({left: ['dateMenu'], center: ['dateMenu']}, CURRENT);
check('an item listed twice is placed once',
    BOXES.flatMap(box => order[box]).filter(id => id === 'dateMenu').length === 1);

const withNew = {...CURRENT, right: ['screenRecording', 'a11y', 'new@ext', 'keyboard', 'quickSettings']};
order = resolveLayout({right: ['quickSettings', 'keyboard', 'a11y', 'screenRecording']}, withNew);
check('a new indicator lands after its neighbour',
    same(order.right, ['quickSettings', 'keyboard', 'a11y', 'new@ext', 'screenRecording']), JSON.stringify(order.right));

const total = resolveLayout({left: ['quickSettings'], right: ['activities']}, CURRENT);
check('no item is lost or duplicated',
    same(BOXES.flatMap(box => total[box]).sort(), BOXES.flatMap(box => CURRENT[box]).sort()));

// --- moveItem ---------------------------------------------------------------
let moved = moveItem(CURRENT, 'dateMenu', 'right', 1);
check('moves across boxes', same(moved.right, ['screenRecording', 'dateMenu', 'a11y', 'keyboard', 'quickSettings']) &&
    same(moved.center, []));
check('does not change the input', same(CURRENT.center, ['dateMenu']));
moved = moveItem(CURRENT, 'quickSettings', 'right', 0);
check('moves inside a box', same(moved.right, ['quickSettings', 'screenRecording', 'a11y', 'keyboard']));
moved = moveItem(CURRENT, 'activities', 'right', Infinity);
check('index past the end appends', moved.right.at(-1) === 'activities');
moved = moveItem(CURRENT, 'activities', 'center', -5);
check('negative index prepends', moved.center[0] === 'activities');

// --- mergeLayout ------------------------------------------------------------
const saved = {right: ['screenRecording', 'ghost@ext', 'a11y', 'keyboard', 'quickSettings'], left: ['activities']};
const merged = mergeLayout(CURRENT, saved);
check('keeps absent items after the same neighbour',
    same(merged.right, ['screenRecording', 'ghost@ext', 'a11y', 'keyboard', 'quickSettings']), JSON.stringify(merged.right));
check('absent item at the start stays first',
    mergeLayout(CURRENT, {left: ['ghost@ext', 'activities']}).left[0] === 'ghost@ext');
check('present items are not duplicated',
    mergeLayout(CURRENT, {right: ['quickSettings']}).right.filter(id => id === 'quickSettings').length === 1);
check('every box is written', BOXES.every(box => Array.isArray(merged[box])));

print(`${count - failures}/${count} checks passed`);
if (failures)
    imports.system.exit(1);
