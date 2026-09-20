# BlueMap Create Railway

A server-side NeoForge addon that adds an operational Create railway layer to BlueMap while leaving BlueMap3D responsible for rendering the actual 3D trains.

## Current first cut

- **Automatic Create station markers** — discovered from Create's global railway graph; no manual marker configuration.
- **Live train labels** — name, speed, state, current/target station, carriage count, driver when available, and whether the train is waiting at a signal.
- **Signal markers** — actual Create signal block positions and current red/yellow/green state, including redstone-forced signals.
- **Dispatch overlay** — track sections are split at Create signal boundaries and colored from Create's own signal-edge-group state:
  - free
  - reserved
  - occupied
  - passive/unsignalled (hidden by default)
- **Dimension-aware** — the addon writes the BlueMap map-to-Minecraft-dimension mapping and only displays data belonging to the map currently being viewed.
- **No BlueMap3D replacement** — the existing BlueMap3D train geometry remains untouched.

The server writes `create-railway/state.json` into BlueMap's web root once per second. The installed web addon polls it and updates markers/line state without recreating existing track geometry on every refresh.

## Target environment

- Minecraft 1.21.1
- NeoForge 21.1.x
- Create 6.0.10–6.0.x
- BlueMap 5.x
- Java 21

The Gradle build is configured against NeoForge `21.1.248` and Create `6.0.10-280`. The mod metadata accepts newer compatible versions within those families.

## Build

The repository includes a GitHub Actions build using Java 21 and Gradle 9.2.1:

```bash
gradle build
```

The resulting JAR is written to:

```text
build/libs/bluemap-create-railway-0.1.0.jar
```

## Install

1. Put the JAR in the server's `mods/` directory alongside Create and BlueMap.
2. Restart the server.
3. Open BlueMap.
4. A **Railway** control appears in the top-right of the map.

The mod installs its frontend automatically into BlueMap's web root:

```text
create-railway/
  create-railway-<version>.js
  create-railway-<version>.css
  integration.json
  state.json
```

No station list or coordinates need to be configured manually.

## Data model

`state.json` is grouped by Minecraft dimension. A dimension contains:

```json
{
  "stations": [],
  "signals": [],
  "segments": [],
  "trains": []
}
```

### Signal sections

Create stores railway occupancy in signal edge groups. The addon splits each physical track edge at signal boundaries, resolves the signal group at each interval, and exports the section with one of:

- `FREE`
- `RESERVED`
- `OCCUPIED`
- `PASSIVE`

Curved track is sampled along the actual Create `TrackEdge`, so the BlueMap overlay follows Create curves rather than drawing straight node-to-node chords.

## Next useful additions

The current data model is intentionally suitable for expansion. The next useful pieces are:

- clicking a 3D BlueMap3D train to open the operational train card rather than using a separate badge;
- highlight an entire train route to its next station;
- show which train owns a reservation and which train is blocking another train;
- station departure boards based on active schedules;
- signal-block hover/click details;
- a full dispatcher mode that dims normal terrain and emphasizes track, stations, trains, and signal blocks;
- separate static network geometry from the 1-second live-state payload for very large railway networks.
