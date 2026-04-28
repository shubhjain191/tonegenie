# Persona Profiles

Put your persona JSON files in this folder and list them in `index.json`.

## Steps

1. Add files here, e.g.:
   - `alexhormozi.json`
   - `naval.json`
2. Update `index.json`:

```json
{
  "files": ["alexhormozi.json", "naval.json"]
}
```

3. Reload the extension in Chrome.
4. Open popup and choose the profile from the dropdown.

## Minimum required fields per profile

- `handle` (string)
- `tone` (string)

Optional but recommended:

- `displayName`
- `niche`
- `avoids` (array)
- `signaturePatterns` (array)
- `hookTypes` (array)
- `examples` (array)
