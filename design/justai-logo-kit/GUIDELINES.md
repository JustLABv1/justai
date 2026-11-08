# JustAI — Logo-Kurzanleitung

## Idee und Dateien
Zwei ineinandergreifende Stränge stehen für einen gemeinsamen Arbeitsraum aus Chat, Transkription und Agents. Die offene Mitte ist Teil des Zeichens.

- `masters/justai-horizontal.svg`: primäres Logo für Header und Dokumente.
- `masters/justai-stacked.svg`: vertikale Anordnung für quadratische Flächen.
- `masters/justai-symbol.svg`: Signet ab 32 px.
- `masters/justai-symbol-small.svg`: eigener Schnitt für 16–24 px.
- `masters/justai-wordmark.svg`: Wortmarke allein.
- `masters/*-reversed.svg`: optisch leicht dünnere Blau-Versionen auf dunklem Grund.
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
| Primary blue | #1764ef | 23 / 100 / 239 | 90 / 58 / 0 / 6 |
| Dark-mode blue | #2675ff | 38 / 117 / 255 | 85 / 54 / 0 / 0 |
| Ink | #141414 | 20 / 20 / 20 | 0 / 0 / 0 / 92 |
| Paper | #f7f7f7 | 247 / 247 / 247 | 0 / 0 / 0 / 3 |

CMYK ist nicht profilabhängig farbverbindlich. Für Druck sind Proof und Profilabstimmung nötig. Pantone-/Sonderfarbnummern sind nicht festgelegt und müssen anhand eines physischen Farbfächers bemustert werden.

Freigegebene Kombinationen: Primary blue auf Paper oder Weiß; Dark-mode blue beziehungsweise Weiß auf Ink; Schwarz auf Weiß. Dark-mode blue auf Weiß vermeiden.

Die blauen Varianten folgen der jeweiligen Primary-Farbe des Frontends. Für rein einfarbige Anwendungen stehen Schwarz und Weiß bereit.

## Typografie und Form
Die Wortmarke ist individuell aus Vektorpfaden konstruiert und benötigt keine Schriftdatei oder externe Font-Lizenz. Nicht durch getippten Text ersetzen. Für begleitende Produktoberflächen die vorhandene UI-Schrift verwenden; System-Sans als Fallback.

Das Logo proportional skalieren, die offene Mitte erhalten und die bereitgestellten Farbvarianten nutzen. Nicht drehen, stauchen, mit Konturen versehen oder um Schatten und Verläufe ergänzen. Auf unruhigen Flächen eine ruhige Hintergrundkachel verwenden.

## Einbindung und Prüfstand
Für Web-Icons den Inhalt von `digital/` in die gewünschte öffentliche Asset-Struktur kopieren. `head-snippet.html` und `site.webmanifest` nehmen die Domain-Wurzel an; bei Unterverzeichnissen die Pfade anpassen. Das Manifest ist ein Icon-Beispiel, keine vollständige PWA-Konfiguration.

Geprüft: SVG-Struktur, geschlossene Füllpfade, keine Live-Schriften/Raster/Filter in den Logo-Mastern; visuelle Prüfung auf hellen und dunklen Flächen sowie bei 16/32/64 px; PNG-Decodierung und Transparenz; ICO mit 16/32/48 px. Die Beispiele in der Präsentation illustrieren die Identität. Die Produkt-Assets sind auf dieselben Primary-Farben abgestimmt. Keine Markenrechtsprüfung durchgeführt.
