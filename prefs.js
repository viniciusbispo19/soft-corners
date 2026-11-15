// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const normalizeId = id => id.trim().replace(/\.desktop$/, '');

const CORNERS = [
    ['round-top-left', 'Superior esquerdo'],
    ['round-top-right', 'Superior direito'],
    ['round-bottom-left', 'Inferior esquerdo'],
    ['round-bottom-right', 'Inferior direito'],
];

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class SoftCornersPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep the settings object alive as long as the window.
        window._settings = settings;
        window.set_default_size(640, 760);

        window.add(this._appearancePage(settings, window));
        window.add(this._windowsPage(settings, window));
    }

    // --- Page 1: how the corners look --------------------------------------
    _appearancePage(settings, window) {
        const page = new Adw.PreferencesPage({
            title: 'Aparência',
            icon_name: 'preferences-desktop-appearance-symbolic',
        });

        // Corners
        const corners = new Adw.PreferencesGroup({
            title: 'Cantos',
            description: 'As mudanças aparecem na hora em todas as janelas.',
        });
        page.add(corners);

        const radiusRow = Adw.SpinRow.new_with_range(0, 48, 1);
        radiusRow.set({
            title: 'Raio',
            subtitle: 'Em pixels. 0 deixa os cantos retos. Padrão: 12',
        });
        settings.bind('corner-radius', radiusRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        corners.add(radiusRow);

        const smoothRow = new Adw.ActionRow({
            title: 'Suavidade',
            subtitle: 'Da curva circular (esquerda) ao "squircle", mais suave, ' +
                'como os ícones do macOS (direita)',
        });
        const smoothScale = new Gtk.Scale({
            adjustment: new Gtk.Adjustment({lower: 0, upper: 1, step_increment: 0.05}),
            draw_value: false,
            hexpand: true,
            width_request: 200,
            valign: Gtk.Align.CENTER,
        });
        smoothScale.add_mark(0, Gtk.PositionType.BOTTOM, null);
        smoothScale.add_mark(1, Gtk.PositionType.BOTTOM, null);
        settings.bind('corner-smoothing', smoothScale.adjustment, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        smoothRow.add_suffix(smoothScale);
        corners.add(smoothRow);

        const whichRow = new Adw.ExpanderRow({
            title: 'Quais cantos arredondar',
            subtitle: 'Por exemplo, só os de cima',
        });
        for (const [key, title] of CORNERS)
            whichRow.add_row(switchRow(settings, key, title));
        corners.add(whichRow);

        // Shadow
        const shadow = new Adw.PreferencesGroup({title: 'Sombra'});
        page.add(shadow);
        shadow.add(switchRow(settings, 'round-shadow', 'Arredondar a sombra',
            'A sombra nativa da janela acompanha a curva dos cantos. Desligado, ' +
            'ela mantém as pontas retas.'));

        // Border
        const border = new Adw.PreferencesGroup({
            title: 'Borda',
            description: 'Um contorno fino ao longo da borda arredondada, desenhado ' +
                'no mesmo shader (sem atores extras).',
        });
        page.add(border);

        const widthRow = Adw.SpinRow.new_with_range(0, 6, 1);
        widthRow.set({title: 'Espessura', subtitle: 'Em pixels. 0 desliga a borda.'});
        settings.bind('border-width', widthRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        border.add(widthRow);

        const colorRow = new Adw.ActionRow({title: 'Cor'});
        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: true}),
            valign: Gtk.Align.CENTER,
        });
        const loadColor = () => {
            const rgba = new Gdk.RGBA();
            if (rgba.parse(settings.get_string('border-color')))
                colorButton.set_rgba(rgba);
        };
        loadColor();
        colorButton.connect('notify::rgba', () => {
            const text = colorButton.get_rgba().to_string();
            if (text !== settings.get_string('border-color'))
                settings.set_string('border-color', text);
        });
        const colorId = settings.connect('changed::border-color', loadColor);
        window.connect('close-request', () => {
            settings.disconnect(colorId);
            return false;
        });
        colorRow.add_suffix(colorButton);
        colorRow.set_activatable_widget(colorButton);
        border.add(colorRow);
        // The color only matters when there is a border.
        const syncColorSensitive = () => colorRow.set_sensitive(widthRow.get_value() > 0);
        widthRow.connect('notify::value', syncColorSensitive);
        syncColorSensitive();

        // Reset
        const resetGroup = new Adw.PreferencesGroup();
        page.add(resetGroup);
        const resetRow = new Adw.ButtonRow({title: 'Restaurar aparência padrão'});
        resetRow.connect('activated', () => {
            for (const key of ['corner-radius', 'corner-smoothing', 'round-shadow',
                'border-width', 'border-color', ...CORNERS.map(([k]) => k)])
                settings.reset(key);
        });
        resetGroup.add(resetRow);

        return page;
    }

    // --- Page 2: which windows are rounded ---------------------------------
    _windowsPage(settings, window) {
        const page = new Adw.PreferencesPage({
            title: 'Janelas',
            icon_name: 'focus-windows-symbolic',
        });

        const rules = new Adw.PreferencesGroup({
            title: 'Quando arredondar',
            description: 'Janelas em tela cheia nunca são arredondadas. Menus, ' +
                'dicas e popups são sempre ignorados.',
        });
        page.add(rules);
        rules.add(switchRow(settings, 'round-maximized', 'Janelas maximizadas',
            'Mantém os cantos arredondados mesmo com a janela maximizada'));
        rules.add(switchRow(settings, 'round-tiled', 'Janelas lado a lado',
            'Janelas encaixadas em metade da tela'));
        rules.add(switchRow(settings, 'round-dialogs', 'Diálogos e janelas auxiliares',
            'Caixas de diálogo e janelas de ferramentas, além das janelas normais'));

        this._exceptionsGroup(settings, window, page);
        return page;
    }

    _exceptionsGroup(settings, window, page) {
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
