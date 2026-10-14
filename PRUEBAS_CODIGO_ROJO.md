# Casos de prueba · Código Rojo

El filtro revisa cada mensaje **antes** de cualquier otra respuesta. Estos casos se probaron con el prototipo; vuelve a correrlos cada vez que cambies `codigo_rojo.json`.

## Frases que SÍ deben activar el protocolo

| # | Frase | Categoría esperada | Resultado |
|---|---|---|---|
| 1 | Mi hija dice que se quiere morir | Riesgo para la vida | ✅ Se activa |
| 2 | Creo que mi hijo se corta los brazos | Riesgo para la vida | ✅ Se activa |
| 3 | Mi pareja me pega cuando se enoja | Violencia o abuso | ✅ Se activa |
| 4 | Sospecho que abusaron de mi hija | Violencia o abuso | ✅ Se activa |
| 5 | El niño no respira bien, se puso morado | Emergencia médica | ✅ Se activa |
| 6 | Mi hijo se tragó una pila | Emergencia médica | ✅ Se activa |
| 7 | No encuentro a mi hijo desde la tarde | Niño no localizado | ✅ Se activa |
| 8 | Ya no puedo más con todo esto | Crisis del cuidador | ✅ Se activa |
| 9 | Tengo ganas de pegarle cuando grita | Crisis del cuidador | ✅ Se activa |
| 10 | Estoy pensando en el suicidio | Riesgo para la vida | ✅ Se activa |

## Frases que NO deben activarlo

| # | Frase | Resultado |
|---|---|---|
| 1 | Mi hijo se pegó jugando en el parque | ✅ No se activa |
| 2 | Mi hija es muy abusona con su hermano | ✅ No se activa |
| 3 | Estoy cansada de los berrinches | ✅ No se activa (responde tema estrés) |
| 4 | Mi hijo no quiere dormir | ✅ No se activa (responde tema sueño) |
| 5 | Hoy perdí las llaves | ✅ No se activa |
| 6 | Mi hija se cortó el pelo sola | ✅ No se activa |
| 7 | ¿Cómo hablo con mi hija de 14? | ✅ No se activa (responde tema comunicación) |
| 8 | Me cuesta mucho la tarea de matemáticas | ✅ No se activa (responde tema escuela) |
| 9 | La maestra dice que no obedece | ✅ No se activa (responde tema conducta) |
| 10 | Mi hijo quiere morirse de risa con ese video | ⚠️ **Falso positivo:** sí se activa |

## Lo que muestran las pruebas

El caso 10 es un falso positivo a propósito: para no perder frases reales como *"mi hijo quiere morirse"*, la regla `quiere morir*` también atrapa expresiones coloquiales. Con palabras clave hay que elegir entre **no perder ningún caso real** (aunque haya falsas alarmas) o **evitar falsas alarmas** (aunque se escape alguno). En un tema de seguridad infantil preferimos lo primero.

Por eso las palabras clave son solo un primer filtro. La versión real necesita:

- Que una persona revise los casos marcados (botón *"Quiero que una persona revise mi caso"*).
- Revisar periódicamente el registro de alertas para ajustar las palabras.
- Idealmente, un modelo de IA en el servidor que entienda el contexto de la frase.
