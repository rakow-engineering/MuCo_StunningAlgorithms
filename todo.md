Algorithm

Rampup: 

Handler: 
* Beide Handler (sowohl embedded c als auch webapp js sollen sample by sample arbeiten. so dass sie exakt das selbe verhalten erzeugen. 

- bei Integral is es nie ein Fehler wenn nur 1 Wert ganz weit runter geht. KOmmt ein zweiter dazu, wird der erst ab dem zweiten Sample-Point als Warning/Fehler gewertet

Bei integral-Berechnung ist noch ein Fehler: wenn ein Punkt unterhalt der Schwelle ist, dann wird der punkt zwar ignoriert, aber was wird dann nicht mit rein gerechnet, evtl kann man die Fläche anzeigen über dei das Integtal gebildet wird. Es müsste dann ja eine Art Stair Diagramm sein. 
IDEE: Zwischen den Punkten linear-interpolieren, um so exakt den virtuellen Schnittpunkt mit der Threashold-level zu ermitteln. 


IDEE; Das könnte man auch bei der Warnung/Fehler Duration messung machen. 

UI: 
- Burger-Menü einführen
- Dark/Bright mode einführen
- PDF Export 
- Delete sample Punkt nur im Touch-Modus anzeigen


Overlay: 

* Horizontale Marker: 
- fail und warn marker anzeigen, auch auf welchem der oberen Werte sie beruhen, 
- Integral-Schwellwerte anzeigen 
- Wenn abbruch ohne Fertigstellung, dann ist der status false, trotzde, wird im hinteren Bereich des CHarts success und grünes Overlay angezeigt. 
