# 🃏 Yopoker: Texas Hold'em en la TV

Poker local para la noche con los cuates. La mesa se ve en la TV, cada jugador ve **solo sus cartas** en su cel, y el dealer controla todo desde el suyo. No necesita internet, solo el WiFi de la casa.

## Arrancar

```bash
npm install     # solo la primera vez
npm start
```

| Pantalla | Dónde | Cómo |
|---|---|---|
| 📺 **TV** | La laptop conectada a la tele | Se abre sola (`http://localhost:3100/tv`). Click en "Click para empezar" |
| 🎩 **Dealer** | Tu cel | Escaneá el QR que sale en la **terminal** (lleva tu llave) |
| 📱 **Jugadores** (hasta 8) | El cel de cada quien | Escanean el QR que sale en la **TV** y ponen su nombre |

Todos tienen que estar en el mismo WiFi que la laptop.

## Cómo se juega

- **Texas Hold'em No-Limit.** El servidor lleva los turnos, las ciegas, las subidas mínimas, el all-in y los side pots, y decide quién gana.
- **Cartas privadas:** cada cel recibe solo sus 2 cartas. Vienen boca abajo y se ven **manteniendo presionado** (en ⋯ se pueden dejar siempre visibles).
- **Acciones:** retirarse, pasar, igualar, subir (con atajos de mínimo, ½ pozo, pozo y all-in).
- **Tiempo por turno** (60 s por defecto): si se acaba, pasa si puede o se retira.
- **Repartir solo:** si está activado, la siguiente mano arranca 8 s después de que termina una.
- **El que se queda sin fichas: shot** 🥃. El dealer también puede mandar a tomar a cualquiera.

## Si algo sale mal

| Problema | Solución |
|---|---|
| Alguien se fue al baño o se le murió el cel | Dealer → "Pasar/retirar por él" o "Retirarlo" |
| Hubo un error en la mano | Dealer → "Cancelar mano" (devuelve las fichas) |
| A alguien se le bloqueó el cel | Al desbloquearlo se reconecta solo con sus mismas cartas |
| Se cerró la terminal | `npm start` otra vez: la mesa sigue donde iba |
| Alguien se quedó sin fichas | Dealer → ⋯ en el jugador → Recompra |

## Pruebas

```bash
npm test
```

Incluye una simulación de 3,000 manos al azar que verifica que nunca se creen ni se pierdan fichas.
