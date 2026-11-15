// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SoftCornersEffect} from './effect.js';

const EFFECT_NAME = 'soft-corners';

const NORMAL_TYPES = new Set([Meta.WindowType.NORMAL]);
// Dialog-like windows, rounded unless "round-dialogs" is off. Menus,
// tooltips, popups, docks, the desktop, notifications, DND icons and
// override-redirect windows are always ignored.
const DIALOG_TYPES = new Set([
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
]);

// Keys that only change how the corners look (sent to the shader).
const STYLE_KEYS = [
    'corner-radius', 'corner-smoothing', 'round-top-left', 'round-top-right',
    'round-bottom-left', 'round-bottom-right', 'round-shadow',
    'border-width', 'border-color',
];
// Keys that change which windows get the effect.
const RULE_KEYS = ['round-maximized', 'round-tiled', 'round-dialogs', 'excluded-apps'];

function normalizeId(id) {
    return id.trim().toLowerCase().replace(/\.desktop$/, '');
}

// Parses "rgba(r,g,b,a)", "rgb(r,g,b)" (as written by Gdk.RGBA.to_string)
// and "#rrggbb[aa]" into straight RGBA in 0…1.
function parseColor(text) {
    const fallback = [1, 1, 1, 0.15];
    const s = text.trim().toLowerCase();
    let m = s.match(/^rgba?\(([^)]*)\)$/);
    if (m) {
        const parts = m[1].split(',').map(v => parseFloat(v));
        if (parts.length < 3 || parts.some(Number.isNaN))
            return fallback;
        const [r, g, b, a = 1] = parts;
        return [r / 255, g / 255, b / 255, Math.min(1, Math.max(0, a))];
    }
    m = s.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);
    if (m) {
        const n = parseInt(m[1], 16);
        const a = m[2] ? parseInt(m[2], 16) / 255 : 1;
        return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, a];
    }
    return fallback;
}

export default class SoftCornersExtension extends Extension {
    enable() {
        // Meta.WindowActor -> {window, effect, signals: [[object, id]], reordering}
        this._tracked = new Map();
        this._pendingSources = new Set();

        this._settings = this.getSettings();
        this._style = this._readStyle();
        this._excluded = this._readExcluded();
        this._settingsId = this._settings.connect('changed', (_s, key) => {
            if (STYLE_KEYS.includes(key)) {
                this._style = this._readStyle();
                for (const record of this._tracked.values()) {
                    if (record.effect)
                        record.effect.style = this._style;
                }
            } else if (RULE_KEYS.includes(key)) {
                this._excluded = this._readExcluded();
                for (const actor of this._tracked.keys())
                    this._sync(actor);
            }
        });

        this._windowCreatedId = global.display.connect('window-created',
            (_display, window) => this._onWindowCreated(window));

        for (const actor of global.get_window_actors())
            this._track(actor);
    }

    disable() {
        this._settings.disconnect(this._settingsId);
        this._settingsId = 0;
        this._settings = null;
        this._style = null;
        this._excluded = null;

        global.display.disconnect(this._windowCreatedId);
        this._windowCreatedId = 0;

        for (const id of this._pendingSources)
            GLib.source_remove(id);
        this._pendingSources = null;

        for (const actor of [...this._tracked.keys()])
            this._untrack(actor);
        this._tracked = null;
    }

    _onWindowCreated(window) {
        const actor = window.get_compositor_private();
        if (actor) {
            this._track(actor);
            return;
        }

        // The actor is normally created before 'window-created', but be safe.
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pendingSources.delete(id);
            const lateActor = window.get_compositor_private();
            if (lateActor)
                this._track(lateActor);
            return GLib.SOURCE_REMOVE;
        });
        this._pendingSources.add(id);
    }

    _track(actor) {
        if (this._tracked.has(actor))
            return;

        const window = actor.get_meta_window();
        if (!window)
            return;

        const record = {window, effect: null, signals: [], reordering: false};
        this._tracked.set(actor, record);

        const connect = (object, signal, callback) =>
            record.signals.push([object, object.connect(signal, callback)]);

        connect(actor, 'destroy', () => this._untrack(actor));
        // Another effect was added/removed (e.g. wobbly windows' DeformEffect).
        connect(actor, 'notify::effect', () => this._keepInnermost(actor));
        for (const prop of ['maximized-horizontally', 'maximized-vertically',
            'fullscreen', 'window-type', 'wm-class', 'gtk-application-id'])
            connect(window, `notify::${prop}`, () => this._sync(actor));

        this._sync(actor);
    }

    _untrack(actor) {
        const record = this._tracked.get(actor);
        if (!record)
            return;

        for (const [object, id] of record.signals)
            object.disconnect(id);
        record.signals = [];

        this._removeEffect(actor, record);
        this._tracked.delete(actor);
    }

    _shouldRound(window) {
        if (window.is_override_redirect() || window.is_fullscreen())
            return false;

        const type = window.get_window_type();
        if (!NORMAL_TYPES.has(type) &&
            !(DIALOG_TYPES.has(type) && this._settings.get_boolean('round-dialogs')))
            return false;

        const flags = window.get_maximize_flags();
        if (flags === Meta.MaximizeFlags.BOTH && !this._settings.get_boolean('round-maximized'))
            return false;
        // Half-screen tiling maximizes in one direction only.
        if (flags !== Meta.MaximizeFlags.NONE && flags !== Meta.MaximizeFlags.BOTH &&
            !this._settings.get_boolean('round-tiled'))
            return false;

        return !this._isExcluded(window);
    }

    _readStyle() {
        const s = this._settings;
        return {
            radius: s.get_int('corner-radius'),
            smoothing: s.get_double('corner-smoothing'),
            corners: ['round-top-left', 'round-top-right', 'round-bottom-left', 'round-bottom-right']
                .map(key => s.get_boolean(key) ? 1 : 0),
            roundShadow: s.get_boolean('round-shadow'),
            borderWidth: s.get_int('border-width'),
            borderColor: parseColor(s.get_string('border-color')),
        };
    }

    _readExcluded() {
        return new Set(this._settings.get_strv('excluded-apps')
            .map(normalizeId).filter(id => id.length > 0));
    }

    // Matches WM_CLASS (class and instance), the GTK application id, the
    // Flatpak/Snap app id and the .desktop id GNOME Shell associates with
    // the window, case-insensitively and with or without ".desktop".
    _isExcluded(window) {
        if (this._excluded.size === 0)
            return false;

        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const candidates = [
            window.get_wm_class(),
            window.get_wm_class_instance(),
            window.get_gtk_application_id(),
            window.get_sandboxed_app_id(),
            app?.get_id(),
        ];
        return candidates.some(id => id && this._excluded.has(normalizeId(id)));
    }

    _sync(actor) {
        const record = this._tracked.get(actor);
        if (!record)
            return;

        if (this._shouldRound(record.window))
            this._addEffect(actor, record);
        else
            this._removeEffect(actor, record);
    }

    _addEffect(actor, record) {
        if (record.effect)
            return;
        record.effect = new SoftCornersEffect(this._style);
        record.reordering = true;
        actor.add_effect_with_name(EFFECT_NAME, record.effect);
        record.reordering = false;
    }

    _removeEffect(actor, record) {
        if (!record.effect)
            return;
        record.reordering = true;
        actor.remove_effect(record.effect);
        record.reordering = false;
        record.effect = null;
    }

    // Clutter paints effects outermost-first: the FIRST effect in the list
    // wraps all the others, so the LAST one is applied to the window pixels
    // first. Our clip must be the innermost (last) effect, so that effects
    // like wobbly windows' DeformEffect (added on grab, appended to the end)
    // deform the already-rounded window instead of us clipping an already
    // deformed image with a static rectangle.
    _keepInnermost(actor) {
        const record = this._tracked.get(actor);
        if (!record?.effect || record.reordering)
            return;

        const effects = actor.get_effects();
        if (effects.at(-1) === record.effect || !effects.includes(record.effect))
            return;

        record.reordering = true;
        actor.remove_effect(record.effect);
        actor.add_effect_with_name(EFFECT_NAME, record.effect);
        record.reordering = false;
    }
}
