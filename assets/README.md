# Assets

Für die PDF-Wochenberichte erwartet der Bot standardmäßig das bib-Logo unter:

`assets/BIB_Logo_4c1.jpg`

Alternativ kann der Pfad in `.env` gesetzt werden:

`WEEKLY_REPORT_LOGO_PATH=/vollstaendiger/pfad/BIB_Logo_4c1.jpg`

Fehlt die Datei, wird der PDF-Bericht weiterhin erzeugt, aber der Bot schreibt eine Warnung ins Log und erzeugt die PDF ohne Logo.
