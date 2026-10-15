---
name: polyhaven-3d-assets
description: Sources CC0-licensed 3D models from Polyhaven for interior/exterior scene building. Use when adding furniture, plants, lighting, or props to a React Three Fiber or Three.js scene (e.g. homeplan project). Covers API search, URL construction, and R3F integration.
---

# Polyhaven 3D Assets

## License

All Polyhaven models are **CC0** (Creative Commons Zero / public domain). No attribution required. No commercial restrictions. Safe to embed in any product.

## Polyhaven API

Base URL: `https://api.polyhaven.com`

### Search models by category

```
GET https://api.polyhaven.com/assets?t=models
```

Optional filter by category slug (URL-encoded):

```
GET https://api.polyhaven.com/assets?t=models&c=furniture
GET https://api.polyhaven.com/assets?t=models&c=plants
GET https://api.polyhaven.com/assets?t=models&c=lighting
GET https://api.polyhaven.com/assets?t=models&c=outdoor
```

Response: `{ "asset_id": { "name": "...", "categories": [...], "type": 2 }, ... }`

### Get download URL for a model

```
GET https://api.polyhaven.com/files/{asset_id}
```

GLTF download URL pattern (prefer `1k` for web, `2k` for higher quality):

```
https://dl.polyhaven.org/file/ph-assets/Models/gltf/{resolution}/{asset_id}/{asset_id}_{resolution}.gltf
```

Example:
```
https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/wooden_stool_02/wooden_stool_02_1k.gltf
```

Note: GLTF references external textures hosted on Polyhaven's CDN. Textures load automatically when the browser fetches the GLTF. No manual texture wiring needed.

## Resolution guide

| Resolution | Use case |
|---|---|
| `1k` | Web app default — fast load, good quality |
| `2k` | High-quality preview or hero items |
| `4k` | Export/print only — too heavy for browser |

Never use `4k` or `8k` in a browser scene.

## Categories relevant to homeplan

| Category slug | Contents |
|---|---|
| `furniture` | sofas, chairs, tables, beds, shelves |
| `plants` | indoor plants, trees, cacti, bonsai |
| `lighting` | lamps, chandeliers, pendants |
| `outdoor` | garden furniture, planters |
| `electronics` | TVs, monitors, audio equipment |

## Integration — React Three Fiber

Install dependencies once per project:

```bash
npm install three @react-three/fiber @react-three/drei
```

Load and place a Polyhaven model:

```tsx
import { useGLTF } from '@react-three/drei'

const POLYHAVEN_BASE = 'https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k'

function PolyhavenModel({ assetId, position = [0, 0, 0], scale = 1 }) {
  const url = `${POLYHAVEN_BASE}/${assetId}/${assetId}_1k.gltf`
  const { scene } = useGLTF(url)
  return <primitive object={scene.clone()} position={position} scale={scale} />
}

// Usage in scene:
// <PolyhavenModel assetId="wooden_stool_02" position={[1, 0, 2]} />
// <PolyhavenModel assetId="armchair_01" position={[-1, 0, 0]} scale={0.8} />
```

Use `scene.clone()` when placing the same model multiple times — avoids shared geometry mutation.

## Workflow when adding a new object to homeplan

1. Search the Polyhaven API or browse polyhaven.com for the object by name/category.
2. Note the `asset_id` (slug in the URL, e.g. `wooden_stool_02`).
3. Construct the `1k` GLTF URL.
4. Add a `PolyhavenModel` component to the scene with position and scale.
5. Verify load time is acceptable; downgrade resolution only if needed.
6. Preload frequently used models with `useGLTF.preload(url)` at the module level.

## Performance notes

- Polyhaven CDN allows direct browser fetch — no CORS issues.
- Cache is handled by the browser for repeated renders.
- Avoid loading more than ~20 unique models in one scene without LOD management.
- For large scenes, consider downloading models to your own `/public/models/` folder and serving locally.

## Completion

A model integration is done when: the asset_id is confirmed on polyhaven.com, the GLTF loads without console errors, position/scale matches the scene context, and the frame rate stays within the project's performance budget.
