# FlyBrain - Interactive Virtual Drosophila

A browser-based virtual fruit fly driven by the FlyWire connectome, living in a small 3D garden. Users interact with the fly and its habitat (drop fruit, hang or remove spiderwebs, touch, blow air, change light and temperature), and it responds through local senses, neural activity and a documented motor adapter.

> **Current implementation (garden, FLY-WORLD-PLAN).** The sections from "Core Concept" down describe the original v0.1 canvas app and are kept for history. The implemented behavior is summarized in "Garden (current)" below and specified in detail in [docs/world-model.md](docs/world-model.md).

## Garden (current)

- **World.** A 120 × 90 body-length walled orchard (Three.js r128, with a Canvas 2D fallback):
  - three fruit trees and seeded, capped fruit replenishment
  - two orb webs with snag-and-release contact
  - a trellis, stones and a leaf shelter
  - a soft breeze and local shade
- **Coordinates.** Units are body lengths and seconds (coordinate version `world-bl-v1`). The camera never moves anything in the world.
- **Senses → brain.** Odor at two antennae (wind-stretched field), taste only on contact, a visual web cue per eye (size, expansion, contrast, line of sight), touch, wind and light. These stimulate hemisphere-specific neuron populations from a versioned sidecar.
- **Brain → body.**
  - The worker is stepped once per 100 ms with step IDs, and one step at most is outstanding.
  - Descending-neuron, lateral-horn and proboscis-motor-neuron readouts drive a modeled VNC adapter. Every term is labeled connectome-driven or modeled.
  - Body physics runs at a fixed 60 Hz with swept collisions.
- **Behavior.** FlyPolicy states:

  | State | Enters when |
  |---|---|
  | idle | walking drive is low |
  | walk | walking drive is up (odor keeps it walking) |
  | feed | proboscis output is high **and** the head touches edible fruit |
  | groom | grooming urge is high |
  | rest | fatigue is high |
  | startle | escape output is urgent |
  | fly | takeoff output |
  | brace | a gust hits the antennae |
  | snagged | the fly touches silk |

  Only consumed nutrition reduces hunger. Urgent defense interrupts feeding and rest.
- **Modes.**
  - *Connectome + modeled steering* (default): adds a labeled bilateral odor comparison and odor-gated upwind turning.
  - *Connectome readout only*: those two terms are off.
  - *Fallback*: the 59-group approximation, used only if the connectome fails.
- **Tools.** Observe, Fruit, Web, Touch, Air, Light, Temp, Follow, Pause, Reset, and an Inspect panel (trace, events, experiments, inspection), plus Scent, Danger, Trail and Neural overlays. Runs are seeded and replayable from logs; the caretaker uses the same command API in world coordinates.
- **Evidence.** [docs/connectome-baseline.md](docs/connectome-baseline.md) and [docs/world-experiments.md](docs/world-experiments.md).

## Origin
Forked from [heyseth/worm-sim](https://github.com/heyseth/worm-sim). Same concept (connectome-driven creature in the browser), different organism.

## Core Concept

A 2D fly lives on a canvas. It has internal drives (hunger, fear, fatigue, curiosity) that change over time. Users interact with it through a toolbar of actions. The fly's "brain" -- a simplified Drosophila connectome (~50-80 functional neuron groups) -- processes sensory input and produces behavioral output.

The fly is not scripted. Its behavior emerges from signal propagation through weighted neural connections, just like the original worm-sim, but with fly-appropriate circuits and behaviors.

## Interactions

| Action | Input Method | Sensory Pathway | Fly Response |
|--------|-------------|-----------------|-------------|
| **Feed** | Click food tool, then click near fly | Gustatory neurons (GR) | Proboscis extension, feeding, satiation |
| **Touch** | Click touch tool, then click on fly body | Mechanosensory neurons (bristle) | Startle, groom, or flee depending on location + stress |
| **Blow air** | Click air tool, then click/drag near fly | Wind-sensing neurons (JO, arista) | Brace, orient, or take off |
| **Light** | Toggle light level (bright/dim/dark) | Photoreceptor neurons (R1-R8) | Phototaxis (move toward light), or settle in dark |
| **Offer mate** | Click mate tool (stretch goal) | Olfactory neurons (OR) | Courtship or avoidance depending on state |
| **Do nothing** | Wait | Internal clock | Idle behaviors: grooming, exploring, resting |

## Fly Body

Top-down 2D view:
- Elliptical body (thorax + abdomen)
- Head with compound eyes (2 red ovals)
- 6 legs (3 pairs, articulated)
- 2 wings (folded at rest, spread when flying)
- Proboscis (retracted, extends when feeding)
- Antennae (2, on head)

Rendered as canvas paths or SVG overlay. Body parts animate independently based on current behavior.

## Brain Architecture

### Functional Regions (~50-80 neuron groups)

Abstracted from the FlyWire connectome into functional clusters:

**Sensory (input)**
- Visual: R1-R6 (motion), R7-R8 (color), lobula plate (direction-selective)
- Olfactory: ORN (odor receptor neurons), projection neurons
- Gustatory: GRN (sugar, bitter, water)
- Mechanosensory: bristle neurons (touch), Johnston's organ (wind/gravity), chordotonal (proprioception)

**Central Processing**
- Mushroom body: learning, memory, context
- Central complex: navigation, orientation, locomotion coordination
- Lateral horn: innate odor responses
- SEZ (subesophageal zone): feeding command center

**Motor (output)**
- Leg motor neurons (6 legs, walk CPG)
- Wing motor neurons (flight muscles)
- Proboscis motor neurons (feeding)
- Head/neck motor neurons (orientation)
- Abdominal motor neurons (grooming)

### Signal Flow
```
User Interaction -> Sensory Neurons -> Central Processing -> Motor Neurons -> Behavior
                                            ^
                                            |
                                    Internal Drives (hunger, fear, fatigue)
```

### Internal Drives
Each drive is a float 0.0-1.0 that changes over time:
- **Hunger**: increases steadily (~0.01/sec), decreases when fed, modulates food-seeking
- **Fear**: spikes on touch/air, decays over ~10s, modulates startle threshold
- **Fatigue**: increases with activity, decreases at rest, modulates movement speed
- **Curiosity**: fluctuates randomly, modulates exploration vs. staying put

Drives bias the central processing neurons, shifting which motor outputs win.

## Behaviors

Each behavior is a state with entry conditions, animations, and exit conditions:

| Behavior | Trigger | Animation | Duration |
|----------|---------|-----------|----------|
| **Walk** | Default when curious + not tired | Legs alternate in tripod gait | Continuous |
| **Groom** | After touch, or periodic (idle) | Legs rub head/body, specific to touched area | 2-5s |
| **Feed** | Food nearby + hungry | Proboscis extends, body lowers | Until sated or food removed |
| **Startle** | Sudden touch or air blast | Freeze 200ms, then jump/fly away | 0.5-2s |
| **Fly** | High fear, or strong air stimulus | Wings spread, lift off, relocate | 1-3s |
| **Rest** | High fatigue | Wings fold tight, legs tuck, minimal movement | 5-15s |
| **Explore** | Moderate curiosity, low fear | Slow walk with direction changes, antenna movement | Continuous |
| **Phototaxis** | Light gradient detected | Walk toward brighter area | Until in bright zone |

## UI Layout

```
+----------------------------------------------------------+
|  [Feed] [Touch] [Air] [Light] [?]      FlyBrain v0.1    |
+----------------------------------------------------------+
|                                                          |
|                                                          |
|                    [fly on canvas]                        |
|                                                          |
|                                                          |
+----------------------------------------------------------+
|  Connectome: [ooo ooo ooo ooo ooo ooo]   |  Hunger: === |
|  [toggle]                                 |  Fear:   =   |
|                                           |  Fatigue:==  |
+----------------------------------------------------------+
```

- Top toolbar: interaction tools (click to select, then click on canvas to use)
- Center: full-width canvas with the fly
- Bottom left: connectome visualization (colored dots by region)
- Bottom right: drive meters (hunger, fear, fatigue, curiosity)

## Tech Stack
- Vanilla JS (keeping it simple, no build step, same as worm-sim)
- HTML5 Canvas for fly body + environment
- CSS for UI chrome
- No backend, no dependencies

## Stretch Goals (not in v0.1)
- Multiple flies with social behavior
- Learning: fly remembers where food was (still future work: the garden has fixed weights and makes no memory claims)
- Sound: wing buzz, feeding sounds
- Mobile touch support
- Connectome editor: adjust weights in real-time
- Export/import fly "personality" (weight presets)
