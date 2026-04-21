Algorithm

rampup: 
- Auch wenn rampup erfolgreich beendet wurde (Marker Ramp) dann soll dennoch während der ersten Sekunde (Timeout) keine weitere Fehleraswertung erfolgen. Ein Einbruch des Strom soll toleriert werden, solane bei erreichen des Timeouts die 	RampUp -Beduingung nach wie vor erfüllt ist. 


Steps: 

/* Initialer Aufstart-Vorgang */ 
1. ramp
	The rampup stemp is a first initial state, that supresses all other state-evaluations


/* Filterung */
2. glitch_merge  --> rename to glitch_ignore 
	The data must not be altered, we only want to ignore some short glitches, without throwing an error or warning state 

/* Überwachung */
3. sustain  
	Here there are limits, that lead to downgrade the state to error or warnig, when value goes below. 
	Limits are not hardly fixed the the profile settings, the thresholds can be set relativ to the setpoints

/* Das sind alles überwachungen die zum Fertigstellen des Vorgangs führen */ 
4. charge_ok --> Bedeutet so viel wie ladung ok. 
    Was macht das? Hat das was mit dem Integral zu tun? 
	scheint als required_duration_s * setpoint_mA zu haben  
5. invalid_check
	das scheint eine Art Timeout zu sein. 
6. total_check: 
    gesamt-timeout (im integral-fall) 
7. duration 
	Betäubungszeit-Ziel (bei nicht ingeral-wert) 
	
	


Handler: 
* Beide Handler (sowohl embedded c als auch webapp js sollen sample by sample arbeiten. so dass sie exakt das selbe verhalten erzeugen. 




Overlay: 
* im Integral-modus, bitte eine zweite Linie anzeigenm die den Integral-Zielwert als linie anzeigt und den wert des Integrals zeitlich darstellt: 

* Horizontale Marker: 
- A und B bitte mit Nominal und Setpoint konsistent beschriften
- fail und warn marker anzeigen, auch auf welchem der oberen Werte sie beruhen, 
  relative marker nur dann anzeigen wenn threshold_percent != 100 


* bei den Visualisierungen anzeigen, aus welchem Grund die validierung fehl schlug (rampup, sustain, glitch, .... ) 

