/* Treselefantes · Acompañante (prototipo)
 * Chatbot basado en reglas. No usa IA ni claves de API: todo el contenido
 * vive en los archivos .json y se puede editar sin tocar este archivo.
 *
 * Flujo de cada mensaje:
 *   1. Normalizar el texto (minúsculas, sin acentos)
 *   2. Revisar Código Rojo  -> si se activa, protocolo de urgencia y terminar
 *   3. Detectar la intención por palabras clave
 *   4. Aplicar reglas de cruce cuidador–niño
 *   5. Responder y registrar la interacción
 */

const estado = {
  datos: null,          // { usuarios, intenciones, cruces, codigoRojo }
  perfil: null,         // perfil activo
  crucesPerfil: [],     // reglas de cruce que aplican al perfil activo
};

const CLAVE_REGISTRO = "treselefantes_registro";

/* ---------- Utilidades ---------- */

// Minúsculas, sin acentos y sin signos, para comparar palabras clave.
function normalizar(texto) {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¿?¡!.,;:()"«»]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Convierte una palabra clave en expresión regular de palabra completa.
// "suicid*" detecta "suicidio", "suicidarme", etc.
function patron(frase) {
  const f = normalizar(frase);
  const comodin = f.endsWith("*");
  const base = (comodin ? f.slice(0, -1) : f).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9ñ])${base}${comodin ? "[a-z0-9ñ]*" : ""}(?=$|[^a-z0-9ñ])`);
}

function coincide(textoNormalizado, frase) {
  return patron(frase).test(textoNormalizado);
}

function rangoEdad(edad) {
  if (edad <= 5) return "0-5";
  if (edad <= 11) return "6-11";
  return "12-18";
}

// Edad de referencia del perfil: el niño mencionado en el mensaje, el primero, o el grupo del docente.
function referencia(perfil, textoNormalizado = "") {
  if (perfil.hijos && perfil.hijos.length) {
    const mencionado = perfil.hijos.find((h) => textoNormalizado.includes(normalizar(h.nombre)));
    const hijo = mencionado || perfil.hijos[0];
    return { nombre: hijo.nombre, edad: hijo.edad };
  }
  if (perfil.grupo) {
    return { nombre: "tu grupo", edad: Math.round((perfil.grupo.edad_min + perfil.grupo.edad_max) / 2) };
  }
  return { nombre: "tu hijo/a", edad: 8 };
}

function areaMasBaja(perfil) {
  return Object.entries(perfil.rueda).sort((a, b) => a[1] - b[1])[0][0];
}

function rellenar(plantilla, perfil, ref) {
  return plantilla
    .replaceAll("{nombre}", perfil.nombre)
    .replaceAll("{hijo}", ref.nombre)
    .replaceAll("{edad}", ref.edad)
    .replaceAll("{area_baja}", areaMasBaja(perfil));
}

/* ---------- Carga de datos ---------- */

async function cargarDatos() {
  const archivos = ["usuarios", "intenciones", "cruces", "codigo_rojo"];
  const respuestas = await Promise.all(
    archivos.map((a) =>
      fetch(`${a}.json`).then((r) => {
        if (!r.ok) throw new Error(`No se pudo leer ${a}.json`);
        return r.json();
      })
    )
  );
  const [usuarios, intenciones, cruces, codigoRojo] = respuestas;
  return { usuarios, intenciones, cruces, codigoRojo };
}

/* ---------- Pantalla de perfiles ---------- */

function mostrarPerfiles() {
  const lista = document.getElementById("lista-perfiles");
  lista.innerHTML = "";
  estado.datos.usuarios.perfiles.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tarjeta-perfil";
    const estresProm = promedio(p.bitacora.map((d) => d.estres)).toFixed(1);
    btn.innerHTML = `
      <span class="rol">${p.rol === "docente" ? "Docente" : "Familia"}</span>
      <h2>${p.nombre}</h2>
      <span>${p.descripcion}</span>
      <span class="dato">Estrés promedio: ${estresProm} de 5 · Último acceso: ${textoAcceso(p.dias_desde_ultimo_acceso)}</span>`;
    btn.addEventListener("click", () => iniciarChat(p));
    lista.appendChild(btn);
  });
  document.getElementById("pantalla-perfiles").hidden = false;
  document.getElementById("pantalla-chat").hidden = true;
}

function promedio(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function textoAcceso(dias) {
  if (dias === 0) return "hoy";
  if (dias === 1) return "ayer";
  return `hace ${dias} días`;
}

/* ---------- Panel del perfil ---------- */

function crucesDelPerfil(perfil) {
  const edades = perfil.hijos.length
    ? perfil.hijos.map((h) => h.edad)
    : perfil.grupo ? [perfil.grupo.edad_min, perfil.grupo.edad_max] : [];
  return estado.datos.cruces.reglas.filter(
    (r) =>
      r.etapas_cuidador.includes(perfil.etapa_cuidador) &&
      edades.some((e) => e >= r.edad_min && e <= r.edad_max)
  );
}

function pintarPanel(perfil) {
  document.getElementById("perfil-nombre").textContent = perfil.nombre;
  document.getElementById("perfil-descripcion").textContent = perfil.descripcion;
  document.getElementById("perfil-etapa").textContent = perfil.etapa_texto;

  const hijos = document.getElementById("perfil-hijos");
  hijos.innerHTML = "";
  if (perfil.hijos.length) {
    perfil.hijos.forEach((h) => (hijos.innerHTML += `<li>${h.nombre}, ${h.edad} años</li>`));
  } else if (perfil.grupo) {
    hijos.innerHTML = `<li>${perfil.grupo.nombre} (${perfil.grupo.edad_min}–${perfil.grupo.edad_max} años)</li>`;
  }

  // Gráfica de barras del estrés (1 a 5) de los últimos 7 días
  const ancho = 280, alto = 96, base = 78, paso = ancho / 7;
  let barras = "";
  perfil.bitacora.forEach((d, i) => {
    const h = (d.estres / 5) * 64;
    const x = i * paso + paso * 0.2;
    barras += `<rect class="barra ${d.estres >= 4 ? "alta" : ""}" x="${x}" y="${base - h}" width="${paso * 0.6}" height="${h}" rx="3"><title>${d.dia}: estrés ${d.estres} de 5</title></rect>`;
    barras += `<text x="${x + paso * 0.3}" y="${base + 14}" text-anchor="middle">${d.dia}</text>`;
  });
  document.getElementById("grafica-estres").innerHTML =
    `<svg viewBox="0 0 ${ancho} ${alto}" role="img" aria-label="Estrés de los últimos 7 días">${barras}</svg>`;

  const rueda = document.getElementById("rueda");
  const baja = areaMasBaja(perfil);
  rueda.innerHTML = "";
  Object.entries(perfil.rueda).forEach(([area, valor]) => {
    rueda.innerHTML += `<li class="${area === baja ? "baja" : ""}"><span>${area}</span><span class="pista"><span class="relleno" style="width:${valor * 10}%"></span></span><span class="num">${valor}</span></li>`;
  });

  const cruces = document.getElementById("cruces-activos");
  cruces.innerHTML = estado.crucesPerfil.length
    ? estado.crucesPerfil.map((c) => `<li>${c.titulo}</li>`).join("")
    : `<li>Sin cruces especiales para este perfil</li>`;

  actualizarContador();
}

/* ---------- Mensajes en pantalla ---------- */

const contenedor = () => document.getElementById("mensajes");

function agregarBurbuja(texto, tipo = "bot") {
  const div = document.createElement("div");
  div.className = `burbuja ${tipo}`;
  div.textContent = texto;
  contenedor().appendChild(div);
  bajarScroll();
  return div;
}

function agregarTip(regla) {
  const div = document.createElement("div");
  div.className = "burbuja tip";
  div.innerHTML = `<strong>Para tu etapa: ${regla.titulo}</strong>${regla.explicacion} ${regla.recomendacion}`;
  contenedor().appendChild(div);
  bajarScroll();
}

function mostrarBotones(lista = []) {
  const zona = document.getElementById("botones-rapidos");
  zona.innerHTML = "";
  lista.forEach((texto) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = texto;
    b.addEventListener("click", () => procesarMensaje(texto));
    zona.appendChild(b);
  });
}

function bajarScroll() {
  const c = contenedor();
  c.scrollTop = c.scrollHeight;
}

// Simula que el bot "escribe" antes de responder.
function conEscribiendo(fn, ms = 650) {
  const ind = document.createElement("div");
  ind.className = "escribiendo";
  ind.setAttribute("aria-label", "El acompañante está escribiendo");
  ind.innerHTML = "<span></span><span></span><span></span>";
  contenedor().appendChild(ind);
  bajarScroll();
  return new Promise((resolve) =>
    setTimeout(() => {
      ind.remove();
      fn();
      resolve();
    }, ms)
  );
}

/* ---------- Inicio de la conversación ---------- */

async function iniciarChat(perfil) {
  estado.perfil = perfil;
  estado.crucesPerfil = crucesDelPerfil(perfil);
  document.getElementById("pantalla-perfiles").hidden = true;
  document.getElementById("pantalla-chat").hidden = false;
  contenedor().innerHTML = "";
  mostrarBotones([]);
  pintarPanel(perfil);

  // Saludo con contexto según la bitácora
  const ultimos3 = perfil.bitacora.slice(-3);
  const estresAlto = ultimos3.filter((d) => d.estres >= 4).length;
  const energiaProm = promedio(perfil.bitacora.map((d) => d.energia));
  const detonantes = perfil.bitacora.flatMap((d) => d.detonantes);
  const frecuente = masFrecuente(detonantes);

  let saludo = `Hola, ${perfil.nombre}.`;
  if (estresAlto >= 2) {
    saludo += ` Veo en tu bitácora que tu estrés ha estado alto en ${estresAlto} de los últimos 3 días${frecuente ? `, y que «${frecuente}» aparece seguido como detonante` : ""}. ¿Quieres que platiquemos de eso?`;
  } else if (energiaProm < 2.5) {
    saludo += ` Esta semana tu energía ha estado baja (${energiaProm.toFixed(1)} de 5 en promedio). ¿Cómo te sientes hoy?`;
  } else {
    saludo += ` Tu semana se ve bastante estable. Tu área más baja en la Rueda de la Vida es «${areaMasBaja(perfil)}». ¿En qué te acompaño hoy?`;
  }

  await conEscribiendo(() => agregarBurbuja(saludo));

  // Recordatorio de continuidad (usuario activo = 3 veces por semana)
  if (perfil.dias_desde_ultimo_acceso > 3) {
    await conEscribiendo(() =>
      agregarBurbuja(
        `Hace ${perfil.dias_desde_ultimo_acceso} días que no te veía por aquí. ¿Te parece si hoy llenamos tu bitácora? Toma menos de un minuto y me ayuda a acompañarte mejor.`,
        "recordatorio"
      )
    );
  }

  // Cruce cuidador–niño más relevante al inicio
  const cruceInicial = estado.crucesPerfil.find((c) => c.temas.includes("saludo_inicial"));
  if (cruceInicial) await conEscribiendo(() => agregarTip(cruceInicial), 500);

  mostrarBotones(
    perfil.rol === "docente"
      ? ["Conflicto en el grupo", "Me siento estresada/o", "¿Qué es el Oráculo?"]
      : ["Me siento estresada/o", "Problemas para dormir", "Berrinches", "¿Cómo lleno mi bitácora?"]
  );
  document.getElementById("campo-mensaje").focus();
}

function masFrecuente(lista) {
  if (!lista.length) return null;
  const cuenta = {};
  lista.forEach((x) => (cuenta[x] = (cuenta[x] || 0) + 1));
  const [top, n] = Object.entries(cuenta).sort((a, b) => b[1] - a[1])[0];
  return n >= 2 ? top : null;
}

/* ---------- Procesamiento de cada mensaje ---------- */

async function procesarMensaje(textoOriginal) {
  const texto = textoOriginal.trim();
  if (!texto || !estado.perfil) return;
  agregarBurbuja(texto, "usuario");
  mostrarBotones([]);
  const norm = normalizar(texto);

  // 1. Código Rojo: siempre primero
  const alerta = revisarCodigoRojo(norm);
  if (alerta) {
    await conEscribiendo(() => mostrarProtocolo(alerta), 400);
    registrar({ intencion: "codigo_rojo", codigo_rojo: true, categoria: alerta.id, revision_humana: false });
    return;
  }

  // 2. Intención
  const intencion = detectarIntencion(norm);
  const perfil = estado.perfil;
  const ref = referencia(perfil, norm);

  if (!intencion) {
    const def = estado.datos.intenciones.por_defecto;
    await conEscribiendo(() => agregarBurbuja(rellenar(def.respuesta, perfil, ref)));
    mostrarBotones(def.botones);
    registrar({ intencion: "no_reconocida", codigo_rojo: false });
    return;
  }

  // 3. Respuesta (según edad cuando aplica)
  let respuesta = intencion.respuesta || "";
  if (intencion.por_edad) {
    respuesta = intencion.por_edad[rangoEdad(ref.edad)];
    if (perfil.hijos.length > 1 && !perfil.hijos.some((h) => norm.includes(normalizar(h.nombre)))) {
      respuesta = `Pensando en ${ref.nombre} (${ref.edad} años): ` + respuesta;
    }
  }
  await conEscribiendo(() => agregarBurbuja(rellenar(respuesta, perfil, ref)));

  // 4. Cruce cuidador–niño relacionado con el tema
  const cruce = estado.crucesPerfil.find((c) => c.temas.includes(intencion.id));
  if (cruce) await conEscribiendo(() => agregarTip(cruce), 450);

  mostrarBotones(intencion.botones);
  registrar({ intencion: intencion.id, codigo_rojo: false, cruce: cruce ? cruce.id : "" });
}

function revisarCodigoRojo(norm) {
  for (const cat of estado.datos.codigoRojo.categorias) {
    if (cat.frases.some((f) => coincide(norm, f))) return cat;
  }
  return null;
}

// Elige la intención con más palabras clave encontradas.
function detectarIntencion(norm) {
  let mejor = null, puntos = 0;
  estado.datos.intenciones.intenciones.forEach((it) => {
    const n = it.palabras.filter((p) => coincide(norm, p)).length;
    if (n > puntos) { mejor = it; puntos = n; }
  });
  return mejor;
}

function mostrarProtocolo(categoria) {
  const p = estado.datos.codigoRojo.protocolo;
  const div = document.createElement("div");
  div.className = "alerta";
  div.setAttribute("role", "alert");
  div.innerHTML = `
    <h3>${p.titulo}</h3>
    <p>${p.mensaje}</p>
    <ul class="recursos">
      ${p.recursos.map((r) => `<li><span><strong>${r.nombre}</strong><br><span class="muted">${r.detalle}</span></span><a class="tel" href="tel:${r.telefono.replace(/\s/g, "")}">${r.telefono}</a></li>`).join("")}
    </ul>
    <button type="button" class="btn-alerta">${p.boton_revision}</button>`;
  const btn = div.querySelector(".btn-alerta");
  btn.addEventListener("click", () => {
    btn.disabled = true;
    btn.textContent = "Solicitud registrada";
    agregarBurbuja(p.confirmacion_revision);
    registrar({ intencion: "codigo_rojo", codigo_rojo: true, categoria: categoria.id, revision_humana: true });
  });
  contenedor().appendChild(div);
  bajarScroll();
  mostrarBotones(["Gracias"]);
}

/* ---------- Registro para tableros ---------- */

function leerRegistro() {
  try {
    return JSON.parse(localStorage.getItem(CLAVE_REGISTRO)) || [];
  } catch {
    return [];
  }
}

function registrar(datos) {
  const fila = {
    fecha: new Date().toISOString(),
    perfil: estado.perfil.id,
    rol: estado.perfil.rol,
    intencion: datos.intencion,
    codigo_rojo: datos.codigo_rojo ? "si" : "no",
    categoria_alerta: datos.categoria || "",
    revision_humana: datos.revision_humana ? "si" : "no",
    cruce: datos.cruce || "",
  };
  const reg = leerRegistro();
  reg.push(fila);
  try { localStorage.setItem(CLAVE_REGISTRO, JSON.stringify(reg)); } catch { /* navegador sin almacenamiento */ }
  actualizarContador();
}

function actualizarContador() {
  document.getElementById("contador-registro").textContent = leerRegistro().length;
}

function descargarCSV() {
  const reg = leerRegistro();
  const columnas = ["fecha", "perfil", "rol", "intencion", "codigo_rojo", "categoria_alerta", "revision_humana", "cruce"];
  const filas = [columnas.join(",")].concat(reg.map((r) => columnas.map((c) => `"${String(r[c] ?? "").replace(/"/g, '""')}"`).join(",")));
  const blob = new Blob(["﻿" + filas.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "registro_chatbot_treselefantes.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------- Arranque ---------- */

document.getElementById("form-mensaje").addEventListener("submit", (e) => {
  e.preventDefault();
  const campo = document.getElementById("campo-mensaje");
  procesarMensaje(campo.value);
  campo.value = "";
});
document.getElementById("btn-cambiar").addEventListener("click", mostrarPerfiles);
document.getElementById("btn-csv").addEventListener("click", descargarCSV);

cargarDatos()
  .then((datos) => {
    estado.datos = datos;
    mostrarPerfiles();
  })
  .catch((err) => {
    const e = document.getElementById("error-carga");
    e.hidden = false;
    e.textContent = `${err.message}. Si abriste index.html directo desde tu computadora, el navegador bloquea la lectura de los archivos JSON: ábrelo con un servidor local (ver README) o desde GitHub Pages.`;
  });

// Exponer funciones para probar el filtro desde la consola del navegador
window.TE = { normalizar, coincide, revisarCodigoRojo, detectarIntencion, estado, cargarDatos };
