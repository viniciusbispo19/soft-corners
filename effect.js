// SPDX-License-Identifier: GPL-3.0-or-later
//
// SoftCornersEffect: a single Clutter.ShaderEffect applied directly to a
// Meta.WindowActor. It clips the window frame's corners with a rounded
// rectangle and nothing else: no extra actors, no cached geometry.
//
// How the coordinates work (Mutter 51, clutter-offscreen-effect.c):
//  * The OffscreenEffect renders the actor into an FBO that covers the
//    actor's paint volume (actor-local coordinates), quantized by
//    _clutter_actor_box_enlarge_for_effects(). If the paint volume is
//    unknown (e.g. the wobbly DeformEffect is on the actor and returns
//    FALSE from modify_paint_volume) it covers the allocation box instead.
//  * The texture is then drawn at fbo_offset, scaled by 1/resource_scale.
// Every frame, in vfunc_paint_target(), we recompute where the window frame
// sits inside that texture and upload it as uniforms. Nothing is cached, so
// resizes, animations and deformations never leave stale geometry behind.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

const DECLARATIONS = `
uniform vec4 sc_bounds;    // frame rect inside the FBO, in texture pixels (x1, y1, x2, y2)
uniform vec2 sc_tex_size;  // FBO texture size in pixels
uniform float sc_radius;   // corner radius in texture pixels (0 = passthrough)

// Sample the FBO at a pixel position; anything outside the texture is
// transparent (no clamp-to-edge smearing of window content).
vec4 sc_sample(vec2 px) {
    if (px.x < 0.0 || px.y < 0.0 || px.x > sc_tex_size.x || px.y > sc_tex_size.y)
        return vec4(0.0);
    return texture2D(cogl_sampler0, px / sc_tex_size);
}
`;

// Runs after Cogl's default fragment code, so cogl_color_out already holds
// texel * paint opacity (premultiplied). Only pixels that are inside the
// frame rect AND inside one of the four corner squares are touched; the
// native shadow outside the frame is never modified.
const FRAGMENT = `
if (sc_radius > 0.0) {
    vec2 px = cogl_tex_coord0_in.st * sc_tex_size;
    vec2 center = (sc_bounds.xy + sc_bounds.zw) * 0.5;
    vec2 half_size = (sc_bounds.zw - sc_bounds.xy) * 0.5;
    vec2 rel = px - center;
    vec2 q = abs(rel) - (half_size - vec2(sc_radius));

    if (q.x > 0.0 && q.y > 0.0 &&
        abs(rel.x) <= half_size.x && abs(rel.y) <= half_size.y) {
        float dist = length(q) - sc_radius;
        float coverage = clamp(0.5 - dist, 0.0, 1.0);

        if (coverage < 1.0) {
            // What should show through the clipped corner is the window's
            // own (native) shadow. Estimate it by sampling the shadow just
            // outside the two frame edges that meet at this corner.
            vec2 dir = sign(rel);
            vec2 corner = center + dir * half_size;
            float off = max(dist, 0.0) + 1.0;
            vec4 sx = sc_sample(vec2(corner.x + dir.x * off, px.y));
            vec4 sy = sc_sample(vec2(px.x, corner.y + dir.y * off));
            vec4 shadow = (sx.a > sy.a ? sx : sy) * cogl_color_in;

            cogl_color_out = mix(shadow, cogl_color_out, coverage);
        }
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

export const SoftCornersEffect = GObject.registerClass(
class SoftCornersEffect extends Clutter.ShaderEffect {
    _init(radius) {
        super._init();
        this._radius = radius;
    }

    set radius(value) {
        this._radius = value;
        this.get_actor()?.queue_redraw();
    }

    get radius() {
        return this._radius;
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
    }

    _updateUniforms() {
        const actor = this.get_actor();
        const window = actor?.get_meta_window?.();
        const texture = this.get_texture();
        if (!window || !texture) {
            this._passthrough();
            return;
        }

        const texW = texture.get_width();
        const texH = texture.get_height();
        // The FBO is rendered at the ceiled resource scale.
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

        const radius = Math.min(this._radius, frameW / 2, frameH / 2) * scale;

        this.set_uniform_float('sc_bounds', 4, [
            (left - offX) * scale,
            (top - offY) * scale,
            (right - offX) * scale,
            (bottom - offY) * scale,
        ]);
        this.set_uniform_float('sc_tex_size', 2, [texW, texH]);
        this.set_uniform_float('sc_radius', 1, [radius]);
    }
});
