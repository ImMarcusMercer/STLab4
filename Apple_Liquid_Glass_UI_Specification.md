# Apple-Inspired Liquid Glass UI Specification

## Purpose

Use this document as the visual and interaction specification when
implementing an Apple-inspired Liquid Glass interface.

The goal is to reproduce the visual language of Apple's modern Liquid
Glass aesthetic while keeping the implementation practical for web,
React, Tailwind, Figma, or other UI frameworks.

This is an Apple-inspired approximation, not a claim that the values
below are Apple's proprietary internal material parameters.

## 1. Core Design Philosophy

Do not treat Liquid Glass as ordinary glassmorphism.

The visual effect should combine:

-   Translucency
-   Background blur
-   Increased color saturation
-   Subtle borders
-   Soft inner highlights
-   Very restrained shadows
-   Selective tinting
-   Dynamic interaction
-   Content-aware appearance
-   Optional refraction/distortion where the platform supports it

The underlying content should remain visually relevant through the
glass.

Avoid making the interface look like a collection of opaque white cards.

## 2. Base Glass Preset

### Light Mode

``` text
Glass fill:          rgba(255, 255, 255, 0.16)
Backdrop blur:       24px
Backdrop saturation: 175%
Border:              1px solid rgba(255, 255, 255, 0.22)
Corner radius:       24px
Inner highlight:     rgba(255, 255, 255, 0.25)
Shadow:              0 4px 20px rgba(0, 0, 0, 0.10)
```

### Dark Mode

``` text
Glass fill:          rgba(255, 255, 255, 0.08)
Backdrop blur:       24px
Backdrop saturation: 175%
Border:              1px solid rgba(255, 255, 255, 0.14)
Corner radius:       24px
Inner highlight:     rgba(255, 255, 255, 0.12)
Shadow:              0 4px 24px rgba(0, 0, 0, 0.25)
```

### Recommended ranges

``` text
Glass opacity:       8–16%
Blur:                20–30px
Saturation:          150–180%
Border opacity:      14–22%
Corner radius:       20–28px
```

Do not automatically increase opacity to make glass more visible.
Improve contrast and hierarchy instead.

## 3. Color Palette

### Light Interface

``` text
Background:          #F5F5F7
Primary text:        #1D1D1F
Secondary text:      #6E6E73
Accent blue:         #007AFF
Glass:               white with ~16% opacity
Glass border:        white with ~22% opacity
```

### Dark Interface

``` text
Background:          #000000 or #101014
Primary text:        #F5F5F7
Secondary text:      #98989D
Accent blue:         #0A84FF
Glass:               white with ~8% opacity
Glass border:        white with ~14% opacity
```

Do not force the entire interface to be monochrome. Allow colorful
content, imagery, gradients, illustrations, and backgrounds to show
through the translucent material.

## 4. CSS Base Implementation

Use this as a starting point for a web implementation:

``` css
.liquid-glass {
    background: rgba(255, 255, 255, 0.16);

    backdrop-filter:
        blur(24px)
        saturate(175%);

    -webkit-backdrop-filter:
        blur(24px)
        saturate(175%);

    border: 1px solid rgba(255, 255, 255, 0.22);

    border-radius: 24px;

    box-shadow:
        0 4px 20px rgba(0, 0, 0, 0.10),
        inset 0 1px 0 rgba(255, 255, 255, 0.25);
}
```

Dark mode:

``` css
.liquid-glass-dark {
    background: rgba(255, 255, 255, 0.08);

    backdrop-filter:
        blur(24px)
        saturate(175%);

    -webkit-backdrop-filter:
        blur(24px)
        saturate(175%);

    border: 1px solid rgba(255, 255, 255, 0.14);

    border-radius: 24px;

    box-shadow:
        0 4px 24px rgba(0, 0, 0, 0.25),
        inset 0 1px 0 rgba(255, 255, 255, 0.12);
}
```

## 5. Buttons

Buttons should generally be more subtle than large glass panels.

### Normal Button

``` css
.liquid-button {
    background: rgba(255, 255, 255, 0.12);

    border: 1px solid rgba(255, 255, 255, 0.20);

    backdrop-filter:
        blur(20px)
        saturate(180%);

    -webkit-backdrop-filter:
        blur(20px)
        saturate(180%);

    border-radius: 999px;

    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.25),
        0 3px 12px rgba(0, 0, 0, 0.10);
}
```

### Primary Button

Use tint selectively for important actions.

``` css
.primary-button {
    background: rgba(0, 122, 255, 0.28);

    border: 1px solid rgba(255, 255, 255, 0.24);

    backdrop-filter:
        blur(20px)
        saturate(180%);

    -webkit-backdrop-filter:
        blur(20px)
        saturate(180%);

    border-radius: 999px;
}
```

Recommended primary tint opacity: 15--30%.

Do not tint every control.

## 6. Background Design

The glass needs something visually interesting behind it.

Good backgrounds include:

-   Soft gradients
-   Colorful photographs
-   Blurred imagery
-   Abstract shapes
-   Subtle system-like wallpapers
-   Large areas of changing color
-   Content with moderate contrast

The background should remain recognizable through the glass, but should
not make text difficult to read.

## 7. Refraction and Distortion

If the target platform supports actual glass refraction, use it subtly.

The effect should be:

-   Low amplitude
-   Smooth
-   Content-aware
-   Most visible around curved edges
-   Never strong enough to make text behind the glass unreadable

Do not simulate refraction with an excessive displacement filter.

## 8. Highlights

Use very subtle specular highlights.

Recommended:

``` text
Inner top highlight:
1px
rgba(255,255,255,0.20–0.25)
```

The highlight should make the material feel dimensional without looking
metallic.

Avoid strong white glow, large outer glow, bright neon outlines, or
heavy gradient borders.

## 9. Shadows

Shadows should establish separation, not create a floating-card effect.

Light mode:

``` text
0 4px 20px rgba(0, 0, 0, 0.10)
```

Dark mode:

``` text
0 4px 24px rgba(0, 0, 0, 0.25)
```

Keep shadows soft.

## 10. Corner Radius

Recommended:

``` text
Small controls:      12–18px
Cards/panels:        20–28px
Large floating UI:   24–32px
Pill controls:       999px
```

Use consistent radii across the design system.

## 11. Interaction

Liquid Glass should feel responsive.

### Hover

-   Slightly increase brightness
-   Slightly increase border visibility
-   Small elevation change
-   Optional subtle scale around 1.01

### Pressed

-   Reduce brightness slightly
-   Reduce scale slightly, around 0.98--0.99
-   Reduce shadow
-   Return smoothly when released

### Focus

Use a clear accessible focus state. Do not rely solely on a subtle glow.

### Transition

``` text
Duration: 150–300ms
Easing: smooth ease-out
```

Avoid slow, dramatic animations for ordinary controls.

## 12. Motion

Good examples:

-   Opacity changes
-   Scale: 0.98 → 1.00
-   Small blur changes
-   Small positional movement
-   Subtle highlight movement

Avoid large bouncing, excessive spring physics, constant floating, rapid
flashing, or strong glass distortion.

## 13. Layering

Use a small number of meaningful glass layers.

Recommended hierarchy:

``` text
Background
    ↓
Primary glass navigation / toolbar
    ↓
Main content
    ↓
Occasional glass controls
```

Avoid repeatedly nesting glass:

``` text
Glass
  ↓
Glass card
  ↓
Glass button
  ↓
Glass input
```

Nested glass creates excessive blur and visual noise.

## 14. Accessibility

The Liquid Glass appearance must not compromise usability.

Maintain:

-   Sufficient text contrast
-   Clearly visible interactive states
-   Visible focus indicators
-   Readable controls
-   Adequate hit targets
-   Reduced-motion support
-   Fallbacks when backdrop blur is unavailable

Example fallback:

``` css
@supports not (backdrop-filter: blur(1px)) {
    .liquid-glass {
        background: rgba(255, 255, 255, 0.90);
    }
}
```

The UI should remain usable without blur or transparency.

## 15. Avoid These Common Mistakes

Do NOT produce generic glassmorphism.

Avoid:

``` text
❌ 40–70% white opacity
❌ Excessively strong blur
❌ Huge dark shadows
❌ Bright neon borders
❌ Heavy outer glow
❌ Every component being glass
❌ Every component having a colored tint
❌ Excessive refraction
❌ Poor text contrast
❌ Excessive rounded rectangles
❌ Strong gradients on every component
❌ Glass stacked on top of glass repeatedly
```

The target is refined, restrained, and adaptive.

## 16. Design Tokens

``` text
LIQUID_GLASS_LIGHT_FILL      = rgba(255,255,255,0.16)
LIQUID_GLASS_DARK_FILL       = rgba(255,255,255,0.08)

LIQUID_GLASS_LIGHT_BORDER    = rgba(255,255,255,0.22)
LIQUID_GLASS_DARK_BORDER     = rgba(255,255,255,0.14)

LIQUID_GLASS_LIGHT_HIGHLIGHT = rgba(255,255,255,0.25)
LIQUID_GLASS_DARK_HIGHLIGHT  = rgba(255,255,255,0.12)

LIQUID_GLASS_BLUR            = 24px
LIQUID_GLASS_SATURATION      = 175%

LIQUID_GLASS_RADIUS          = 24px

LIQUID_GLASS_LIGHT_SHADOW    = 0 4px 20px rgba(0,0,0,0.10)
LIQUID_GLASS_DARK_SHADOW     = 0 4px 24px rgba(0,0,0,0.25)

ACCENT_LIGHT                 = #007AFF
ACCENT_DARK                  = #0A84FF

TEXT_LIGHT_PRIMARY           = #1D1D1F
TEXT_LIGHT_SECONDARY         = #6E6E73

TEXT_DARK_PRIMARY            = #F5F5F7
TEXT_DARK_SECONDARY          = #98989D
```

## 17. Implementation Instructions for an AI Agent

When implementing this design:

1.  Preserve the existing application's functionality.
2.  Do not change business logic unless explicitly requested.
3.  Apply the Liquid Glass treatment primarily to navigation, floating
    controls, important panels, and selected interactive elements.
4.  Keep the background visually relevant.
5.  Use translucent surfaces rather than opaque white cards.
6.  Use approximately 8--16% white opacity as the starting range.
7.  Use approximately 24px backdrop blur.
8.  Use approximately 175% saturation.
9.  Use 1px translucent borders.
10. Use subtle inner highlights.
11. Keep shadows soft.
12. Use approximately 20--28px corner radii for panels.
13. Use pill-shaped controls where appropriate.
14. Use accent tint selectively for primary actions.
15. Add subtle hover and pressed states.
16. Maintain accessibility and readable contrast.
17. Provide a fallback when backdrop filtering is unavailable.
18. Avoid excessive nested glass layers.
19. Do not introduce unnecessary glow, neon effects, or heavy shadows.
20. Do not replace existing application functionality merely to achieve
    the visual style.

Before modifying a project, inspect the existing component structure,
styling system, framework, and design tokens. Reuse existing components
where practical.

## 18. Quality Target

The final result should feel:

``` text
Apple-inspired
    +
Translucent
    +
Adaptive
    +
Minimal
    +
Fluid
    +
Content-aware
    +
Accessible
```

It should NOT feel like:

``` text
Generic glassmorphism
Neumorphism
Neon cyberpunk UI
Frosted Windows-style cards
```

The most important visual principle is:

> The glass should feel like a material interacting with the content
> behind it, not like a transparent rectangle placed on top of the
> interface.
