// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const normalizeId = id => id.trim().replace(/\.desktop$/, '');

export default class SoftCornersPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep the settings object alive as long as the window.
        window._settings = settings;

        const page = new Adw.PreferencesPage({
            title: 'Soft Corners',
            icon_name: 'preferences-desktop-appearance-symbolic',
        });
        window.add(page);

        // --- Appearance ---------------------------------------------------
        const appearance = new Adw.PreferencesGroup({title: 'Aparência'});
        page.add(appearance);

        const radiusRow = Adw.SpinRow.new_with_range(0, 48, 1);
        radiusRow.set({
            title: 'Raio dos cantos',
            subtitle: 'Em pixels. 0 desativa o arredondamento. Padrão: 12',
        });
        settings.bind('corner-radius', radiusRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearance.add(radiusRow);

        // --- Exceptions ---------------------------------------------------
        const exceptions = new Adw.PreferencesGroup({
            title: 'Exceções',
            description: 'Janelas destes aplicativos nunca são arredondadas. ' +
                'Informe o WM_CLASS ou o app-id (ex.: org.gnome.Calculator). ' +
                'Para descobrir o WM_CLASS de uma janela: Alt+F2 → lg → aba Windows.',
        });
        page.add(exceptions);

        const chooseButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'Escolher aplicativo instalado',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        chooseButton.connect('clicked', () =>
            this._chooseApp(window, id => addException(id)));
        exceptions.set_header_suffix(chooseButton);

        const entryRow = new Adw.EntryRow({
            title: 'Adicionar WM_CLASS ou app-id',
            show_apply_button: true,
        });
        entryRow.connect('apply', () => {
            addException(entryRow.get_text());
            entryRow.set_text('');
        });
        exceptions.add(entryRow);

        const getList = () => settings.get_strv('excluded-apps');
        const addException = raw => {
            const id = normalizeId(raw);
            if (!id)
                return;
            const list = getList();
            if (!list.some(e => e.toLowerCase() === id.toLowerCase()))
                settings.set_strv('excluded-apps', [...list, id]);
        };
        const removeException = id =>
            settings.set_strv('excluded-apps', getList().filter(e => e !== id));

        let rows = [];
        const rebuild = () => {
            for (const row of rows)
                exceptions.remove(row);
            rows = getList().map(id => {
                const row = new Adw.ActionRow({title: id});
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    tooltip_text: 'Remover',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                remove.connect('clicked', () => removeException(id));
                row.add_suffix(remove);
                exceptions.add(row);
                return row;
            });
        };
        const changedId = settings.connect('changed::excluded-apps', rebuild);
        window.connect('close-request', () => {
            settings.disconnect(changedId);
            return false;
        });
        rebuild();
    }

    _chooseApp(parent, onChosen) {
        const apps = Gio.AppInfo.get_all()
            .filter(app => app.should_show() && app.get_id())
            .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));

        const dialog = new Adw.Dialog({
            title: 'Escolher aplicativo',
            content_width: 420,
            content_height: 560,
        });

        const search = new Gtk.SearchEntry({
            placeholder_text: 'Buscar aplicativo',
            margin_start: 12,
            margin_end: 12,
            margin_top: 6,
            margin_bottom: 6,
        });

        const list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
            margin_start: 12,
            margin_end: 12,
            margin_bottom: 12,
        });

        for (const app of apps) {
            const row = new Adw.ActionRow({
                title: app.get_display_name(),
                subtitle: normalizeId(app.get_id()),
                activatable: true,
            });
            const icon = app.get_icon();
            if (icon)
                row.add_prefix(new Gtk.Image({gicon: icon, pixel_size: 32}));
            row._searchText = `${app.get_display_name()} ${app.get_id()}`.toLowerCase();
            row.connect('activated', () => {
                onChosen(app.get_id());
                dialog.close();
            });
            list.append(row);
        }

        list.set_filter_func(row => {
            const query = search.get_text().trim().toLowerCase();
            return !query || row._searchText.includes(query);
        });
        search.connect('search-changed', () => list.invalidate_filter());

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(search);
        box.append(new Gtk.ScrolledWindow({
            child: list,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        }));

        const toolbar = new Adw.ToolbarView({content: box});
        toolbar.add_top_bar(new Adw.HeaderBar());
        dialog.set_child(toolbar);
        dialog.present(parent);
    }
}
