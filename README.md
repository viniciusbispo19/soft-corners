# Soft Corners

**A GNOME Shell extension that rounds the corners of every window: any app, any size. It uses one GLSL shader effect applied directly to each window actor, with no extra actors, so it works with wobbly windows without leaving a trail behind.**

## How it works

- **One effect per window, no extra actors.** A single `Clutter.ShaderEffect` is applied directly to each `Meta.WindowActor`. There are no separate actors for shadows, borders or masks, so nothing can lag behind the window while it moves or deforms.
- **Native shadow.** Mutter's own shadow (or the app's client-side shadow) is kept. The shader only changes pixels inside the four corners of the window frame, and fills the clipped corner with the window's own shadow.
- **No cached geometry.** The frame position and the radius are recalculated and uploaded as uniforms on every paint. Resizes and animations never leave stale shapes behind.
- **Works with wobbly windows.** Clutter applies the last effect in an actor's list to the window first. Soft Corners keeps its effect last, so wobbly windows' `DeformEffect` bends a window that is already rounded.
- **Maximized and fullscreen windows** keep square corners. The rounding comes back when they leave those states.
- Rounds normal windows and dialogs. Menus, tooltips, popups, docks and the desktop are ignored.

## Settings

- Corner radius (0–48 px, default 12)
- Exceptions by `WM_CLASS` or app id (for example `org.gnome.Calculator`), with a picker for installed apps

## Requirements

GNOME Shell 51.

## Install from source

```sh
git clone https://github.com/viniciusbispo19/soft-corners.git
cd soft-corners
glib-compile-schemas schemas/
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/soft-corners@viniciusbispo19
```

On Wayland, log out and log back in, then run:

```sh
gnome-extensions enable soft-corners@viniciusbispo19
gnome-extensions prefs soft-corners@viniciusbispo19
```

## Known limitations

- **X11 apps with a Mutter title bar:** while wobbling, the part of Mutter's shadow outside the window can disappear until the animation ends. Clutter gives inner effects only the actor's allocation box when an outer effect reports an unknown paint volume, which wobbly windows does.
- **libadwaita apps** already draw their own rounded corners, so with a smaller radius the difference is barely visible.

---

## Em português

Extensão do GNOME Shell que arredonda os cantos de todas as janelas, de qualquer app e tamanho. Usa um único shader GLSL aplicado direto no ator de cada janela, sem atores extras, por isso funciona com o efeito wobbly sem deixar rastro. Mantém a sombra nativa, deixa os cantos retos em janelas maximizadas e em tela cheia, e tem raio configurável e lista de exceções por WM_CLASS ou app-id.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
