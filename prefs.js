/* SPDX-License-Identifier: GPL-2.0-or-later */
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class AnnotationPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({ title: _('Screen Annotations') });
        const drawGrp = new Adw.PreferencesGroup({
            title: _('Drawing layer'),
            description: _(
                'Use the panel menu “Toggle drawing layer”, or the keyboard shortcut from GSettings key toggle-overlay (default: Super+Alt+A). Mouse, pen, and tablet draw; right or middle button erases.'),
        });
        page.add(drawGrp);

        const grp = new Adw.PreferencesGroup({
            title: _('Content movement (ROI)'),
            description: _(
                'When enabled, a small native helper (anno-motion) compares grey ROI snapshots to estimate (dx,dy). ' +
                    'This is best-effort: raise the confidence threshold if ink jumps. ' +
                    'No full-screen capture is used—only explicit ROI paths wired from the overlay in future versions.'),
        });

        const swSync = new Adw.SwitchRow({ title: _('Enable movement sync'), subtitle: _('Runs matcher on a timer when consent is on (ROI hookup pending).') });
        settings.bind('movement-sync', swSync, 'active', Gio.SettingsBindFlags.DEFAULT);
        grp.add(swSync);

        const swConsent = new Adw.SwitchRow({
            title: _('Consent to ROI analysis'),
            subtitle: _('Required before any grey ROI is sent to the native helper. You can revoke anytime.'),
        });
        settings.bind('movement-consent-roi', swConsent, 'active', Gio.SettingsBindFlags.DEFAULT);
        grp.add(swConsent);

        const thrRow = new Adw.ActionRow({
            title: _('Confidence threshold'),
            subtitle: _('Higher = apply translation only when matcher is more certain.'),
        });
        const thrScale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 1, 0.01);
        thrScale.set_hexpand(true);
        thrScale.set_size_request(200, -1);
        thrScale.set_draw_value(true);
        thrScale.set_digits(2);
        thrScale.set_value(settings.get_double('movement-confidence-threshold'));
        thrScale.connect('value-changed', () => {
            settings.set_double('movement-confidence-threshold', thrScale.get_value());
        });
        thrRow.add_suffix(thrScale);
        grp.add(thrRow);

        const hzRow = new Adw.ActionRow({
            title: _('Max matcher rate (Hz)'),
            subtitle: _('Upper bound for timer when ROI pipeline is connected.'),
        });
        const hzAdj = new Gtk.Adjustment({
            lower: 1,
            upper: 20,
            step_increment: 1,
            page_increment: 2,
            value: settings.get_int('movement-max-hz'),
        });
        const hzSpin = Gtk.SpinButton.new(hzAdj, 1, 0);
        hzAdj.connect('value-changed', () => {
            settings.set_int('movement-max-hz', Math.round(hzAdj.get_value()));
        });
        hzRow.add_suffix(hzSpin);
        grp.add(hzRow);

        page.add(grp);
        window.add(page);
    }
}
