# Trace : suivi GPX hors ligne

PWA pour suivre un parcours GPX à vélo sur une carte topo (courbes de niveau + relief), même sans réseau.
Aucune étape de build : ce sont des fichiers statiques.

## Utilisation
1. Ouvrir l'appli dans Chrome sur le téléphone, puis menu ⋮ → « Ajouter à l'écran d'accueil ».
2. ☰ → « Importer un fichier GPX ».
3. Sur le Wi-Fi : ☰ → « Télécharger la carte » (environ 10 Mo pour 40 km).
4. Pendant la sortie, déverrouiller le téléphone pour voir sa position, les km restants et le D+ restant.
   Glisser le doigt sur le profil d'altitude pour voir un point du parcours sur la carte.

## Données
- Fond de carte : [OpenFreeMap](https://openfreemap.org) (OpenStreetMap). Les chemins non pavés sont en pointillé brun.
- Altitude : [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (AWS). Courbes générées dans l'appli par `maplibre-contour`.
- Tout reste sur le téléphone (IndexedDB + Cache Storage).

## Développement
```bash
python3 -m http.server 8765
```
Puis ouvrir http://localhost:8765. Le GPS et le service worker exigent HTTPS, sauf sur localhost.

À chaque mise à jour publiée, incrémenter `SHELL_CACHE` dans `sw.js` pour que le téléphone récupère les nouveaux fichiers.
