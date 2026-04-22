Algorithm

rampup: 
- Auch wenn rampup erfolgreich beendet wurde (Marker Ramp) dann soll dennoch während der ersten Sekunde (Timeout) keine weitere Fehleraswertung erfolgen. Ein Einbruch des Strom soll toleriert werden, solane bei erreichen des Timeouts die 	RampUp -Beduingung nach wie vor erfüllt ist. 


Steps: 




Handler: 
* Beide Handler (sowohl embedded c als auch webapp js sollen sample by sample arbeiten. so dass sie exakt das selbe verhalten erzeugen. 




Overlay: 

* Horizontale Marker: 
- A und B bitte mit Nominal und Setpoint konsistent beschriften
- fail und warn marker anzeigen, auch auf welchem der oberen Werte sie beruhen, 
  relative marker nur dann anzeigen wenn threshold_percent != 100 


* bei den Visualisierungen anzeigen, aus welchem Grund die validierung fehl schlug (rampup, sustain, glitch, .... ) 

