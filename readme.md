# FlyBrain

Interactive browser simulation of the *Drosophila melanogaster* (fruit fly) brain in a small 3D garden. 139,255 neurons and 2.7M connections from the [FlyWire FAFB v783](https://codex.flywire.ai) connectome run as a leaky integrate-and-fire network in a Web Worker, stepped in lockstep with the fly's body.

A walled orchard, rendered with Three.js, has fruit trees that drop ripe fruit and spiderwebs strung across tempting routes. The fly receives only what it could sense locally: odor at two antennae, taste on contact, a visual cue from webs it can see, touch, wind and light. Those signals stimulate identified neuron populations. Activity read out from the connectome drives a documented motor adapter that moves the fly. Watch a hungry fly follow the smell of fermenting apples, get startled by a web beside them, retreat, and come back.

What is connectome-derived and what is modeled is labeled everywhere: in the brain-mode badge, in the live trace, and in [docs/world-model.md](docs/world-model.md).

## Usage

Serve the folder over HTTP (for example `python3 -m http.server`) and open `index.html`, or visit the hosted version. The connectome loads, the brain settles, and the fly starts in the sunny clearing.

- **Observe** -- click a fruit, web or the fly to see ripeness, remaining food, how visible a web is, or what the fly senses.
- **Fruit** -- click the ground to drop ripe fruit. Only eating reduces hunger.
- **Web** -- hang a web facing the fly, or click one to take it down.
- **Touch / Air** -- touch the fly, or drag to blow a gust.
- **Light / Temp** -- dim the garden, or warm and cool it.
- **Follow / Pause / Reset** -- follow camera; pause world and brain together; new run.
- **Inspect** -- live traces of senses, neural readouts and motor output; an event timeline; repeatable experiments (scenario, seed, steering mode, neural silencing, replay, log export).
- **Garden / Close-up / Fly's eyes** -- the overview; an orbit around the fly (drag to circle it, scroll in to its brain); or first person from the fly's head (drag to look around, scroll to change the field of view), with its brain in an inset.
- **X-ray** -- the fly turns to glass. All 139,255 neurons sit at their FlyWire positions inside its head and flash when they fire in the simulation: blue sensory, purple central, red motor.

In the garden view, drag to pan, scroll to zoom, right-drag to orbit. **F** follows the fly, **C** toggles the close-up, **E** the fly's eyes, **X** the X-ray, and **R** (or **Esc**) returns to the garden. The bottom panel shows all 139K neurons firing (WebGL). **Brain 3D** shows the same recorded activity on a 3D brain.

URL options: `?seed=3&scenario=webPatch&mode=connectome`, `?renderer=2d`, `?brain=legacy`.

## Documentation

- [docs/world-model.md](docs/world-model.md) -- architecture, sensory model, neural encoding and readouts, the modeled motor adapter, limitations, data provisioning.
- [docs/connectome-baseline.md](docs/connectome-baseline.md) -- asset validation, weight calibration, and evidence (or limitations) for each sensory pathway.
- [docs/world-experiments.md](docs/world-experiments.md) -- hungry versus satiated flies, fruit beside a web, hidden versus visible webs, recovery, interventions, and neural controls across seeds.

## Tests and tools

```sh
node tests/run-node.js                         # unit, world and real-worker integration tests
node tests/browser/run-browser-tests.js        # headless-Chrome scenarios (CHROME_PATH to override)
node tools/connectome-baseline.js              # regenerate docs/connectome-baseline.*
node tools/world-experiments.js --seeds 10     # regenerate docs/world-experiments.*
python3 scripts/build_neuron_sidecar.py        # rebuild the hemisphere/identity sidecar (needs numpy)
python3 scripts/build_neuron_positions.py      # rebuild the neuron positions drawn inside the X-ray fly
```

## Data Source

Connectome data from the FlyWire Whole-Brain Connectome:

> Dorkenwald, S., Matsliah, A., Sterling, A.R. *et al.* Neuronal wiring diagram of an adult brain. *Nature* **634**, 124--138 (2024). https://doi.org/10.1038/s41586-024-07558-y

The binary connectome file (`data/connectome.bin.gz`, with `data/neuron_meta.json`, the hemisphere sidecar `data/neuron_sidecar.*` and the neuron positions `data/neuron_positions.*`) is derived from the [FlyWire Codex](https://codex.flywire.ai) public dataset (FAFB v783). Neurons are classified into functional groups (sensory, central, drives, motor) based on FlyWire cell type annotations.

## Origin

Forked from [heyseth/worm-sim](https://github.com/heyseth/worm-sim), which simulated the 302-neuron *C. elegans* connectome in the browser. FlyBrain replaces the worm with a fruit fly and scales from 302 neurons to 139,255.

## License

MIT License -- see [license.md](license.md) for details.

## Acknowledgments

- **FlyWire Consortium** -- for mapping the complete adult *Drosophila* brain connectome and making the data publicly available.
- **Timothy Busbice, Gabriel Garrett, Geoffrey Churchill** and contributors to the [GoPiGo Connectome](https://github.com/Connectome/GoPiGo) -- original connectome-driven robot concept.
- **[Zach Rispoli](https://github.com/zrispo)** -- porting the *C. elegans* connectome to JavaScript.
- **[Seth Miller](https://github.com/heyseth)** -- creating worm-sim, the browser simulation this project is forked from.
