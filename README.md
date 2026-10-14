# Treselefantes · Acompañante (prototipo)

Prototipo académico del chatbot de acompañamiento para **Treselefantes**, una plataforma que orienta a familias y docentes de niñas, niños y adolescentes de 0 a 18 años.

El chatbot usa el historial de cada persona (bitácora y Rueda de la Vida) para personalizar la conversación, aplica reglas que cruzan la etapa del cuidador con la del niño y revisa **cada mensaje primero contra el filtro de Código Rojo** para detectar urgencias.

> ⚠️ Prototipo con **datos 100% inventados**. Funciona con reglas y palabras clave, sin inteligencia artificial ni claves de API. Orienta, pero no sustituye a un profesional.

## Cómo funciona

1. La persona elige un perfil de prueba.
2. Se carga su historial y el bot la saluda con contexto. Si lleva más de 3 días sin entrar, la invita a llenar su bitácora.
3. Cada mensaje se normaliza (minúsculas, sin acentos) y pasa por este orden:
   1. **Código Rojo** → si se activa, muestra el protocolo de urgencia (911, Línea de la Vida) y el botón de revisión humana.
   2. **Intención** → detecta el tema por palabras clave y responde según la edad del niño o del grupo.
   3. **Cruce cuidador–niño** → si aplica, agrega una sugerencia para la etapa del cuidador.
4. Cada interacción se guarda en el navegador y se puede descargar en CSV para los tableros.

## Estructura

```
├── index.html          → la página
├── styles.css          → el diseño
├── chatbot.js          → la lógica
├── PRUEBAS_CODIGO_ROJO.md → casos de prueba del filtro de urgencia
├── usuarios.json       → perfiles de prueba
├── intenciones.json    → palabras clave y respuestas por tema
├── cruces.json         → reglas cuidador–niño
└── codigo_rojo.json    → palabras de alerta y protocolo
```

## Cómo editar el contenido (sin programar)

Todo el contenido está en los cuatro archivos `.json`. Se puede editar directo en GitHub (botón del lápiz):

- **Agregar una palabra clave:** súmala a la lista `palabras` de la intención. Escríbela en minúsculas y sin acentos. Un `*` al final acepta cualquier terminación (`cansad*` detecta *cansada* y *cansado*).
- **Cambiar una respuesta:** edita `respuesta` o el texto de `por_edad` (`0-5`, `6-11`, `12-18`). Puedes usar `{nombre}`, `{hijo}`, `{edad}` y `{area_baja}`.
- **Agregar una regla de cruce:** copia una regla de `cruces.json` y cambia etapas, edades y textos.
- **Agregar una palabra de alerta:** súmala a la categoría correspondiente de `codigo_rojo.json` y vuelve a correr los casos de `PRUEBAS_CODIGO_ROJO.md`.

Cuida que el JSON siga siendo válido (comas y comillas). Si la página deja de cargar después de un cambio, casi siempre es una coma de más o de menos.

## Probarlo en tu computadora

El navegador no deja leer los archivos JSON si abres `index.html` con doble clic. Usa un servidor local:

- **VS Code:** instala la extensión *Live Server*, clic derecho en `index.html` → *Open with Live Server*.
- **Python:** en la carpeta del proyecto, ejecuta `python -m http.server 8000` y abre `http://localhost:8000`.

## Publicarlo en GitHub Pages

1. En el repositorio, ve a **Settings → Pages**.
2. En *Build and deployment*, elige **Deploy from a branch**.
3. Selecciona la rama **main** y la carpeta **/ (root)**. Guarda.
4. En uno o dos minutos aparece la liga: `https://<usuario>.github.io/<repositorio>/`.

## Siguientes pasos para una versión real

- Conectar el chatbot al backend del Oráculo en lugar de usar reglas (la clave de la IA debe vivir en el servidor, nunca en la página).
- Validar las palabras de Código Rojo y el protocolo con especialistas de Treselefantes.
- Guardar el registro en una base de datos con consentimiento, conforme a la LFPDPPP.
