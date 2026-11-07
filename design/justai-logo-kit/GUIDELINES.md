# JustAI — Logo-Kurzanleitung

## Idee und Dateien
Zwei ineinandergreifende Stränge stehen für einen gemeinsamen Arbeitsraum aus Chat, Transkription und Agents. Die offene Mitte ist Teil des Zeichens.

- `masters/justai-horizontal.svg`: primäres Logo für Header und Dokumente.
- `masters/justai-stacked.svg`: vertikale Anordnung für quadratische Flächen.
- `masters/justai-symbol.svg`: Signet ab 32 px.
- `masters/justai-symbol-small.svg`: eigener Schnitt für 16–24 px.
- `masters/justai-wordmark.svg`: Wortmarke allein.
- `masters/*-reversed.svg`: optisch leicht dünnere Sand-Versionen auf dunklem Grund.
- `digital/`: schwarze, weiße und Markenfarbvarianten, transparente PNGs, App-Icon und vollständiges Web-Icon-Set.

## Abstände und Mindestgrößen
Freiraum außerhalb des sichtbaren Zeichens: mindestens eine halbe Strangbreite (24 Einheiten im 256er Signet). Im horizontalen Logo beträgt der Abstand zwischen Signet und Wortmarke 72 Einheiten; die Anordnung als Ganzes skalieren.

| Version | Bildschirm | Druck, Richtwert |
|---|---|---|
| Horizontal | mindestens 120 px breit | mindestens 30 mm breit |
| Gestapelt | mindestens 96 px breit | mindestens 24 mm breit |
| Signet | 32 px; kleiner den Small-Schnitt verwenden | mindestens 6 mm |
| Small-Signet | mindestens 16 px | für digitale Kleinformate |

## Farbpalette
| Farbe | HEX | RGB | CMYK, rechnerischer Startwert (%) |
|---|---|---|---|
| Umber | #6B5144 | 107 / 81 / 68 | 0 / 24 / 36 / 58 |
| Sand | #F3D7B5 | 243 / 215 / 181 | 0 / 12 / 26 / 5 |
| Ink | #24211F | 36 / 33 / 31 | 0 / 8 / 14 / 86 |
| Paper | #F8F5F0 | 248 / 245 / 240 | 0 / 1 / 3 / 3 |

CMYK ist nicht profilabhängig farbverbindlich. Für Druck sind Proof und Profilabstimmung nötig. Pantone-/Sonderfarbnummern sind nicht festgelegt und müssen anhand eines physischen Farbfächers bemustert werden.

Freigegebene Kombinationen: Umber auf Paper oder Weiß; Sand beziehungsweise Weiß auf Ink; Schwarz auf Weiß. Sand auf Weiß vermeiden.

Kontrast: Umber/Paper 6.69:1; Sand/Ink 11.58:1.

## Typografie und Form
Die Wortmarke ist individuell aus Vektorpfaden konstruiert und benötigt keine Schriftdatei oder externe Font-Lizenz. Nicht durch getippten Text ersetzen. Für begleitende Produktoberflächen die vorhandene UI-Schrift verwenden; System-Sans als Fallback.

Das Logo proportional skalieren, die offene Mitte erhalten und die bereitgestellten Farbvarianten nutzen. Nicht drehen, stauchen, mit Konturen versehen oder um Schatten und Verläufe ergänzen. Auf unruhigen Flächen eine ruhige Hintergrundkachel verwenden.

## Einbindung und Prüfstand
Für Web-Icons den Inhalt von `digital/` in die gewünschte öffentliche Asset-Struktur kopieren. `head-snippet.html` und `site.webmanifest` nehmen die Domain-Wurzel an; bei Unterverzeichnissen die Pfade anpassen. Das Manifest ist ein Icon-Beispiel, keine vollständige PWA-Konfiguration.

Geprüft: SVG-Struktur, geschlossene Füllpfade, keine Live-Schriften/Raster/Filter in den Logo-Mastern; visuelle Prüfung auf hellen und dunklen Flächen sowie bei 16/32/64 px; PNG-Decodierung und Transparenz; ICO mit 16/32/48 px. Die Beispiele in der Präsentation illustrieren die Identität. Die Anwendung selbst wurde nicht umgestellt. Keine Markenrechtsprüfung durchgeführt.
