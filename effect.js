// SPDX-License-Identifier: GPL-3.0-or-later
//
// SoftCornersEffect: a single Clutter.ShaderEffect applied directly to a
// Meta.WindowActor. Everything happens in one fragment shader: clipping the
// corners, reshaping the native shadow around them and an optional border.
// No extra actors, no cached geometry.
//
// How the coordinates work (Mutter 51, clutter-offscreen-effect.c):
//  * The OffscreenEffect renders the actor into an FBO that covers the
//    actor's paint volume (actor-local coordinates), quantized by
//    _clutter_actor_box_enlarge_for_effects(). If the paint volume is
//    unknown it covers the allocation box instead.
//  * The texture is then drawn at fbo_offset, scaled by 1/resource_scale.
// Every frame, in vfunc_paint_target(), we recompute where the window frame
// sits inside that texture and upload it as uniforms. Nothing is cached, so
// resizes, animations and deformations never leave stale geometry behind.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

const DECLARATIONS = `
uniform vec4 sc_bounds;        // frame rect inside the FBO, in texture px (x1, y1, x2, y2)
uniform vec2 sc_tex_size;      // FBO texture size in px
uniform float sc_radius;       // corner extent in texture px: where the curve starts (0 = square)
uniform vec4 sc_corners;       // 1 = round this corner: top-left, top-right, bottom-left, bottom-right
uniform float sc_exponent;     // 2 = circular arc, ~3.26 = macOS continuous corner
uniform float sc_round_shadow; // 1 = reshape the native shadow around rounded corners
uniform float sc_border_width; // border width in texture px (0 = none)
uniform vec4 sc_border_color;  // straight (non-premultiplied) RGBA

// Sample the FBO at a pixel position; anything outside the texture is
// transparent (no clamp-to-edge smearing of window content).
vec4 sc_sample(vec2 px) {
    if (px.x < 0.0 || px.y < 0.0 || px.x > sc_tex_size.x || px.y > sc_tex_size.y)
        return vec4(0.0);
    return texture2D(cogl_sampler0, px / sc_tex_size);
}

float sc_corner_enabled(vec2 dir) {
    if (dir.y < 0.0)
        return dir.x < 0.0 ? sc_corners.x : sc_corners.y;
    return dir.x < 0.0 ? sc_corners.z : sc_corners.w;
}

// Distance from the corner's centre, for q >= 0. p = 2 is a circle; p > 2 is
// a superellipse, whose curvature fades to zero where it meets the straight
// edges (a "continuous" corner, like macOS windows).
float sc_norm(vec2 q) {
    if (sc_exponent <= 2.001)
        return length(q);
    vec2 a = pow(max(q, vec2(0.0)), vec2(sc_exponent));
    return pow(a.x + a.y, 1.0 / sc_exponent);
}
`;

// Runs after Cogl's default fragment code, so cogl_color_out already holds
// texel * paint opacity (premultiplied).
//
// Only the four corner quadrants are touched (beyond the centres of the
// corner arcs). There:
//  * inside the arc: the window content, untouched;
//  * outside the arc: a "rounded" version of the window's own shadow. The
//    native shadow (Mutter's for X11 windows, the client's for CSD windows)
//    follows the rectangular window, so its corners stick out as a square
//    of "glass". We rebuild it from the native shadow along the two straight
//    edges, sampled at the same distance from the rounded edge, so it keeps
//    the native colour, softness and offset but follows the curve.
const FRAGMENT = `
if (sc_radius > 0.0 || sc_border_width > 0.0) {
    vec2 px = cogl_tex_coord0_in.st * sc_tex_size;
    vec2 center = (sc_bounds.xy + sc_bounds.zw) * 0.5;
    vec2 half_size = (sc_bounds.zw - sc_bounds.xy) * 0.5;
    vec2 rel = px - center;
    vec2 dir = vec2(rel.x < 0.0 ? -1.0 : 1.0, rel.y < 0.0 ? -1.0 : 1.0);
    vec2 a = abs(rel);
    bool inside = a.x <= half_size.x && a.y <= half_size.y;
    float r = sc_radius * sc_corner_enabled(dir);
    vec2 q = a - (half_size - vec2(r));

    if (r > 0.0 && q.x > 0.0 && q.y > 0.0) {
        float dist = sc_norm(q) - r;

        if (dist > -0.5 && (inside || sc_round_shadow > 0.5)) {
            float d = max(dist, 0.0);
            vec2 edge = center + dir * half_size;
            vec2 arc_center = center + dir * (half_size - vec2(r));
            // Native shadow on the vertical edge (beside the corner) and on
            // the horizontal edge (above/below it), at distance d.
            vec4 side = sc_sample(vec2(edge.x + dir.x * d, arc_center.y));
            vec4 cap = sc_sample(vec2(arc_center.x, edge.y + dir.y * d));
            vec2 u = normalize(q);
            vec4 shadow = mix(cap, side, u.x * u.x) * cogl_color_in;

            float coverage = clamp(0.5 - dist, 0.0, 1.0);
            cogl_color_out = mix(shadow, cogl_color_out, coverage);
        }
    }

    if (sc_border_width > 0.0 && inside) {
        // Signed distance to the (rounded) frame edge: negative inside.
        vec2 qq = a - (half_size - vec2(r));
        float sd = (qq.x > 0.0 && qq.y > 0.0) ? sc_norm(qq) - r
                                               : max(qq.x, qq.y) - r;
        float ring = clamp(sd + sc_border_width + 0.5, 0.0, 1.0) *
                     clamp(0.5 - sd, 0.0, 1.0);
        float alpha = sc_border_color.a * ring * cogl_color_in.a;
        vec4 border = vec4(sc_border_color.rgb * alpha, alpha);
        cogl_color_out = border + cogl_color_out * (1.0 - alpha);
    }
}
`;

// CLUTTER_NEARBYINT (round half to even), as used by
// _clutter_actor_box_enlarge_for_effects().
function nearbyint(v) {
    const r = Math.round(v);
    return Math.abs(v - Math.trunc(v)) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// Mirrors clutter_offscreen_effect_pre_paint(): returns the FBO origin in
// actor-local logical pixels. Must be called while the effect is painting
// (so the paint volume is computed in the same context as pre_paint).
function fboOrigin(actor) {
    const volume = actor.get_paint_volume();
    let x1, y1, x2, y2;
    let rawX = 0, rawY = 0;

    if (volume) {
        const origin = volume.get_origin();
        x1 = origin.x;
        y1 = origin.y;
        x2 = x1 + volume.get_width();
        y2 = y1 + volume.get_height();
    } else {
        const box = actor.get_allocation_box();
        ({x1, y1, x2, y2} = box);
        rawX = box.x1;
        rawY = box.y1;
    }

    if ((x2 - x1) * (y2 - y1) !== 0) {
        const w = nearbyint(x2 - x1);
        const h = nearbyint(y2 - y1);
        x2 = Math.ceil(x2 + 0.75);
        y2 = Math.ceil(y2 + 0.75);
        x1 = x2 - w - 3;
        y1 = y2 - h - 3;
    }

    return [Math.trunc(x1 - rawX), Math.trunc(y1 - rawY)];
}

// macOS continuous corners (UIBezierPath / NSBezierPath "continuous" corner
// curve): for a corner radius r, the curve starts 1.52866483·r from the
// corner instead of r, and its 45° point sits where a circular corner of
// radius r would put it.
const APPLE_EXTENT = 1.52866483;
const CIRCLE_INSET_45 = 1 - Math.SQRT1_2;   // 45° inset of a circular corner, ×r

/**
 * Corner shape for a radius r (any unit) and a smoothing s in [0, 1]:
 * s = 0 is a circular arc; s = 1 is a superellipse fitted to the macOS
 * continuous corner (max deviation 0.0091·r, i.e. under 0.1 px at r = 10).
 * Every s keeps the 45° point of the circle, so the corner looks the same
 * size and only the curvature changes.
 *
 * @returns {{extent: number, exponent: number}}
 */
export function cornerShape(r, s) {
    const k = 1 + (APPLE_EXTENT - 1) * Math.min(1, Math.max(0, s));
    // Superellipse of half-size k·r through the circle's 45° point:
    // k·(1 − 2^(−1/n)) = 1 − 1/√2   ⇒   n = ln 2 / −ln(1 − (1 − 1/√2)/k)
    const exponent = Math.LN2 / -Math.log(1 - CIRCLE_INSET_45 / k);
    return {extent: k * r, exponent};
}

/**
 * @typedef {object} CornerStyle
 * @property {number} radius - logical px (the macOS-style corner radius)
 * @property {number[]} corners - [tl, tr, bl, br], 1 = rounded
 * @property {number} smoothing - 0 (circular arc) … 1 (macOS continuous corner)
 * @property {boolean} roundShadow
 * @property {number} borderWidth - logical px
 * @property {number[]} borderColor - straight RGBA, 0…1
 */

export const SoftCornersEffect = GObject.registerClass(
class SoftCornersEffect extends Clutter.ShaderEffect {
    _init(style) {
        super._init();
        this._style = style;
    }

    /** @param {CornerStyle} style */
    set style(style) {
        this._style = style;
        this.get_actor()?.queue_redraw();
    }

    // Called once per class by ClutterShaderEffect; shared by all instances.
    vfunc_get_static_snippet() {
        return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, FRAGMENT);
    }

    vfunc_paint_target(node, paintContext) {
        // Never let an error here skip the chain-up: that would leave the
        // window unpainted (invisible). Fall back to an unclipped window.
        try {
            this._updateUniforms();
        } catch (e) {
            if (!this._errorLogged) {
                this._errorLogged = true;
                logError(e, 'Soft Corners: failed to update shader uniforms');
            }
            try {
                this._passthrough();
            } catch {}
        }
        super.vfunc_paint_target(node, paintContext);
    }

    _passthrough() {
        this.set_uniform_float('sc_radius', 1, [0]);
        this.set_uniform_float('sc_border_width', 1, [0]);
    }

    _updateUniforms() {
        const actor = this.get_actor();
        const window = actor?.get_meta_window?.();
        const texture = this.get_texture();
        const style = this._style;
        if (!window || !texture || (style.radius <= 0 && style.borderWidth <= 0)) {
            this._passthrough();
            return;
        }

        const texW = texture.get_width();
        const texH = texture.get_height();
        // Logical px -> FBO px. The OffscreenEffect renders the FBO at the
        // ceiled resource scale and draws it back divided by that same value
        // (clutter_actor_get_resource_scale() is already ceilf()), so a radius
        // in logical px looks the same size on any monitor: 10 px at scale 1,
        // 20 device px at scale 2, and the right size at fractional scales.
        const scale = Math.ceil(actor.get_resource_scale());
        const [offX, offY] = fboOrigin(actor);

        // Frame rect in actor-local coordinates. The actor's origin is the
        // buffer rect origin; use the actor's current size for the far edges
        // so we follow what is actually painted (e.g. during resizes).
        const frame = window.get_frame_rect();
        const buffer = window.get_buffer_rect();
        const [actorW, actorH] = actor.get_size();
        const left = frame.x - buffer.x;
        const top = frame.y - buffer.y;
        const right = actorW - (buffer.x + buffer.width - (frame.x + frame.width));
        const bottom = actorH - (buffer.y + buffer.height - (frame.y + frame.height));

        const frameW = right - left;
        const frameH = bottom - top;
        if (frameW <= 0 || frameH <= 0 || texW <= 0 || texH <= 0) {
            this._passthrough();
            return;
        }

        // The curve may not run past the middle of a side.
        const shape = cornerShape(style.radius, style.smoothing);
        const fit = Math.min(1, frameW / 2 / shape.extent, frameH / 2 / shape.extent);
        const extent = shape.extent * fit * scale;

        this.set_uniform_float('sc_bounds', 4, [
            (left - offX) * scale,
            (top - offY) * scale,
            (right - offX) * scale,
            (bottom - offY) * scale,
        ]);
        this.set_uniform_float('sc_tex_size', 2, [texW, texH]);
        this.set_uniform_float('sc_radius', 1, [extent]);
        this.set_uniform_float('sc_corners', 4, style.corners);
        this.set_uniform_float('sc_exponent', 1, [shape.exponent]);
        this.set_uniform_float('sc_round_shadow', 1, [style.roundShadow ? 1 : 0]);
        this.set_uniform_float('sc_border_width', 1, [style.borderWidth * scale]);
        this.set_uniform_float('sc_border_color', 4, style.borderColor);
    }
});
