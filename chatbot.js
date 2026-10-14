/* Treselefantes · Acompañante (prototipo v2)
 * Chatbot basado en reglas. No usa IA ni claves de API: todo el contenido
 * vive en los archivos .json y se puede editar sin tocar este archivo.
 *
 * Flujo de CADA mensaje (en cualquier punto de la conversación):
 *   1. Normalizar el texto (minúsculas, sin acentos, sin letras repetidas, abreviaturas)
 *   2. Revisar Código Rojo  -> si se activa, protocolo de urgencia y terminar
 *   3. Buscar un tema nuevo (intención)
 *   4. Si no hay tema nuevo, usar el contexto: «sí», «¿qué más?», «no funcionó»
 *      continúan el último tema; «no» cierra con amabilidad
 *   5. Si tampoco, reflejar la emoción detectada o pedir que cuente más
 *   6. Aplicar reglas de cruce cuidador–niño, responder y registrar
 */

const estado = {
  datos: null,          // { usuarios, intenciones, cruces, codigoRojo }
  perfil: null,         // perfil activo
  crucesPerfil: [],     // reglas de cruce que aplican al perfil activo
  ctx: null,            // memoria de la conversación
};

function nuevoContexto() {
  return {
    tema: null,            // id del último tema tratado
    temaPendiente: null,   // tema que el bot ofreció y espera un «sí»
    vistas: {},            // cuántas respuestas/ideas se han mostrado por tema
    crucesMostrados: new Set(),
    fallos: 0,             // mensajes seguidos sin entender
    modoCuidado: false,    // se activó un Código Rojo en esta conversación
  };
}

const CLAVE_REGISTRO = "treselefantes_registro";

/* ---------- Normalización y comparación ---------- */

const ABREVIATURAS = {
  q: "que", k: "que", xq: "porque", pq: "porque", porq: "porque", x: "por",
  tb: "tambien", tmb: "tambien", tbn: "tambien", d: "de", xfa: "por favor",
  porfa: "por favor", ntp: "no te preocupes", nose: "no se", ps: "pues",
};

// Minúsculas, sin acentos, sin signos, sin letras repetidas («holaaa» → «hola») y con abreviaturas expandidas.
function normalizar(texto) {
  const base = texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ*\s]/g, " ")
    .replace(/([a-z])\1{2,}/g, "$1")
    .replace(/([a-z])\1+(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return base
    .split(" ")
    .map((p) => ABREVIATURAS[p] || p)
    .join(" ");
}

// ¿a y b difieren en una sola letra (cambio, de más o de menos) fuera de las dos últimas posiciones?
// Tolera errores de dedo («suisidio») sin confundir palabras que cambian al final («cortarme» / «cortarle»).
function unErrorDeDedo(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1 || Math.min(la, lb) < 6) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (i >= Math.min(la, lb) - 2) return false;
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1);
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function palabraCoincide(palabraMsg, palabraClave) {
  if (palabraClave.endsWith("*")) {
    const raiz = palabraClave.slice(0, -1);
    if (palabraMsg.startsWith(raiz)) return true;
    return raiz.length >= 6 && unErrorDeDedo(palabraMsg.slice(0, raiz.length + 1), raiz) ||
           raiz.length >= 6 && unErrorDeDedo(palabraMsg.slice(0, raiz.length), raiz);
  }
  if (palabraMsg === palabraClave) return true;
  if (palabraMsg === palabraClave + "s" || palabraMsg === palabraClave + "es") return true;
  return unErrorDeDedo(palabraMsg, palabraClave);
}

const cacheFrases = new Map();
function tokens(frase) {
  if (!cacheFrases.has(frase)) cacheFrases.set(frase, normalizar(frase).split(" "));
  return cacheFrases.get(frase);
}

// ¿La frase clave aparece, palabra por palabra, dentro del mensaje?
function coincide(textoNormalizado, frase) {
  const msg = textoNormalizado.split(" ");
  const clave = tokens(frase);
  for (let i = 0; i + clave.length <= msg.length; i++) {
    if (clave.every((c, j) => palabraCoincide(msg[i + j], c))) return true;
  }
  return false;
}

/* ---------- Datos del perfil ---------- */

function rangoEdad(edad) {
  if (edad <= 5) return "0-5";
  if (edad <= 11) return "6-11";
  return "12-18";
}

// Edad de referencia: el niño mencionado en el mensaje, el primero, o el grupo del docente.
function referencia(perfil, textoNormalizado = "") {
  if (perfil.hijos && perfil.hijos.length) {
    const mencionado = perfil.hijos.find((h) => textoNormalizado.split(" ").includes(normalizar(h.nombre)));
    const hijo = mencionado || estado.ctx?.ultimoHijo || perfil.hijos[0];
    if (mencionado && estado.ctx) estado.ctx.ultimoHijo = mencionado;
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

function rellenar(plantilla, perfil, ref, extra = {}) {
  let t = plantilla
    .replaceAll("{nombre}", perfil.nombre)
    .replaceAll("{hijo}", ref.nombre)
    .replaceAll("{edad}", ref.edad)
    .replaceAll("{area_baja}", areaMasBaja(perfil));
  Object.entries(extra).forEach(([k, v]) => (t = t.replaceAll(`{${k}}`, v)));
  return t;
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
function conEscribiendo(fn, ms = 600) {
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
  estado.ctx = nuevoContexto();
  document.getElementById("pantalla-perfiles").hidden = true;
  document.getElementById("pantalla-chat").hidden = false;
  document.getElementById("barra-emergencia").classList.remove("activa");
  contenedor().innerHTML = "";
  mostrarBotones([]);
  pintarPanel(perfil);

  // Saludo con contexto según la bitácora. Deja un tema "pendiente" para que un «sí» tenga sentido.
  const ultimos3 = perfil.bitacora.slice(-3);
  const estresAlto = ultimos3.filter((d) => d.estres >= 4).length;
  const energiaProm = promedio(perfil.bitacora.map((d) => d.energia));
  const frecuente = masFrecuente(perfil.bitacora.flatMap((d) => d.detonantes));

  let saludo = `Hola, ${perfil.nombre}.`;
  if (estresAlto >= 2) {
    saludo += ` Veo en tu bitácora que tu estrés ha estado alto en ${estresAlto} de los últimos 3 días${frecuente ? `, y que «${frecuente}» aparece seguido como detonante` : ""}. ¿Quieres que platiquemos de eso?`;
    estado.ctx.temaPendiente = frecuente === "ruido" ? "ruido" : "estres";
  } else if (energiaProm < 2.5) {
    saludo += ` Esta semana tu energía ha estado baja (${energiaProm.toFixed(1)} de 5 en promedio). ¿Quieres que veamos cómo recuperar un poco de energía?`;
    estado.ctx.temaPendiente = "estres";
  } else if (perfil.rol === "docente") {
    saludo += ` Tu semana se ve bastante estable, aunque «${frecuente || "el grupo"}» aparece en tu bitácora. ¿Quieres que platiquemos de tu grupo?`;
    estado.ctx.temaPendiente = "grupo";
  } else {
    saludo += ` Tu semana se ve bastante estable. Tu área más baja en la Rueda de la Vida es «${areaMasBaja(perfil)}». ¿Quieres ideas para cuidarla?`;
    estado.ctx.temaPendiente = "tiempo_para_mi";
  }

  await conEscribiendo(() => agregarBurbuja(saludo));

  // Recordatorio de continuidad (usuario activo = 3 veces por semana)
  if (perfil.dias_desde_ultimo_acceso > 3) {
    await conEscribiendo(() =>
      agregarBurbuja(
        `Por cierto, hace ${perfil.dias_desde_ultimo_acceso} días que no te veía por aquí. Cuando puedas, llena tu bitácora: toma menos de un minuto y me ayuda a acompañarte mejor.`,
        "recordatorio"
      )
    );
  }

  // Cruce cuidador–niño más relevante al inicio
  const cruceInicial = estado.crucesPerfil.find((c) => c.temas.includes("saludo_inicial"));
  if (cruceInicial) {
    estado.ctx.crucesMostrados.add(cruceInicial.id);
    await conEscribiendo(() => agregarTip(cruceInicial), 450);
  }

  mostrarBotones(
    perfil.rol === "docente"
      ? ["Sí", "Conflicto en el grupo", "Me siento estresada/o", "¿Qué es el Oráculo?"]
      : ["Sí", "Problemas para dormir", "Berrinches", "¿Cómo lleno mi bitácora?"]
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

let ocupado = false;

async function procesarMensaje(textoOriginal) {
  const texto = textoOriginal.trim();
  if (!texto || !estado.perfil || ocupado) return;
  ocupado = true;
  try {
    agregarBurbuja(texto, "usuario");
    mostrarBotones([]);
    await responder(texto);
  } finally {
    ocupado = false;
  }
}

async function responder(texto) {
  const norm = normalizar(texto);
  const ctx = estado.ctx;
  const perfil = estado.perfil;
  const datos = estado.datos.intenciones;
  const ref = referencia(perfil, norm);

  // 1. Código Rojo: SIEMPRE primero, en cualquier punto de la conversación
  const alerta = revisarCodigoRojo(norm);
  if (alerta) {
    ctx.modoCuidado = true;
    ctx.tema = null;
    ctx.temaPendiente = null;
    document.getElementById("barra-emergencia").classList.add("activa");
    await conEscribiendo(() => mostrarProtocolo(alerta), 350);
    registrar({ intencion: "codigo_rojo", codigo_rojo: true, categoria: alerta.id });
    return;
  }

  // 2. ¿Un tema nuevo?
  const tema = detectarIntencion(norm, "tema");
  if (tema) {
    ctx.fallos = 0;
    await responderTema(tema, ref, norm);
    return;
  }

  // 3. Respuestas cortas que dependen del contexto
  const conversacion = detectarIntencion(norm, "conversacion");
  if (conversacion && (conversacion.id === "afirmacion" || conversacion.id === "mas_info")) {
    const pendiente = ctx.temaPendiente && buscarTema(ctx.temaPendiente);
    const actual = ctx.tema && buscarTema(ctx.tema);
    if (conversacion.id === "afirmacion" && pendiente && pendiente.id !== ctx.tema) {
      ctx.fallos = 0;
      await responderTema(pendiente, ref, norm);
      return;
    }
    if (actual || pendiente) {
      ctx.fallos = 0;
      await darMasIdeas(actual || pendiente, ref);
      return;
    }
  }
  if (conversacion && conversacion.id === "negacion") {
    ctx.temaPendiente = null;
    await conEscribiendo(() => agregarBurbuja(rellenar(datos.respuesta_negacion, perfil, ref)));
    mostrarBotones(datos.por_defecto.botones.slice(0, 5));
    registrar({ intencion: "negacion" });
    return;
  }

  // 4. Emoción sin tema claro: reflejarla y preguntar
  const emocion = detectarEmocion(norm);
  if (emocion) {
    ctx.fallos = 0;
    await conEscribiendo(() => agregarBurbuja(rellenar(datos.emociones.respuesta, perfil, ref, { emocion })));
    mostrarBotones(["Conmigo", "Con mis hijos", "Con la escuela"]);
    registrar({ intencion: "emocion" });
    return;
  }

  // 5. No se entendió: variar la respuesta y ofrecer temas
  const opciones = datos.por_defecto.respuestas;
  const texto_def = opciones[Math.min(ctx.fallos, opciones.length - 1)];
  ctx.fallos++;
  await conEscribiendo(() => agregarBurbuja(rellenar(texto_def, perfil, ref)));
  mostrarBotones(datos.por_defecto.botones);
  registrar({ intencion: "no_reconocida" });
}

function buscarTema(id) {
  return estado.datos.intenciones.intenciones.find((i) => i.id === id);
}

// Elige una respuesta del tema que no se haya mostrado aún (rota para no repetirse).
async function responderTema(tema, ref, norm) {
  const ctx = estado.ctx;
  const perfil = estado.perfil;
  let lista = tema.respuestas || [];
  if (tema.por_edad) lista = tema.por_edad[rangoEdad(ref.edad)] || [];
  if (!lista.length) lista = ["Cuéntame un poco más sobre eso."];

  const visto = ctx.vistas[tema.id] || { r: 0, m: 0 };
  let texto = lista[visto.r % lista.length];
  visto.r++;
  ctx.vistas[tema.id] = visto;

  if (tema.por_edad && perfil.hijos.length > 1 && !perfil.hijos.some((h) => norm.split(" ").includes(normalizar(h.nombre)))) {
    texto = `Pensando en ${ref.nombre} (${ref.edad} años): ` + texto;
  }
  if (estado.ctx.modoCuidado && tema.id !== "a_salvo" && tema.id !== "gracias") {
    texto = "Sigo aquí contigo. " + texto;
  }

  await conEscribiendo(() => agregarBurbuja(rellenar(texto, perfil, ref)));

  // Cruce cuidador–niño relacionado con el tema (solo una vez por conversación)
  const cruce = estado.crucesPerfil.find((c) => c.temas.includes(tema.id) && !ctx.crucesMostrados.has(c.id));
  if (cruce) {
    ctx.crucesMostrados.add(cruce.id);
    await conEscribiendo(() => agregarTip(cruce), 400);
  }

  ctx.tema = tema.id;
  ctx.temaPendiente = tema.mas && tema.mas.length ? tema.id : null;
  if (tema.pregunta && tema.mas && tema.mas.length) {
    await conEscribiendo(() => agregarBurbuja(tema.pregunta), 300);
    mostrarBotones(["Sí", ...tema.botones].slice(0, 4));
  } else {
    mostrarBotones(tema.botones);
  }
  registrar({ intencion: tema.id, cruce: cruce ? cruce.id : "" });
}

// «Sí», «¿qué más?», «no funcionó»: siguiente idea del tema en curso.
async function darMasIdeas(tema, ref) {
  const ctx = estado.ctx;
  const perfil = estado.perfil;
  const datos = estado.datos.intenciones;
  const visto = ctx.vistas[tema.id] || { r: 0, m: 0 };
  const ideas = tema.mas || [];

  if (visto.m < ideas.length) {
    const idea = ideas[visto.m];
    visto.m++;
    ctx.vistas[tema.id] = visto;
    ctx.tema = tema.id;
    await conEscribiendo(() => agregarBurbuja(rellenar(idea, perfil, ref)));
    if (visto.m < ideas.length) {
      ctx.temaPendiente = tema.id;
      mostrarBotones(["Otra idea", ...tema.botones].slice(0, 4));
    } else {
      ctx.temaPendiente = null;
      mostrarBotones(tema.botones.length ? tema.botones : datos.por_defecto.botones.slice(0, 4));
    }
    registrar({ intencion: tema.id + "_mas" });
  } else {
    ctx.temaPendiente = null;
    await conEscribiendo(() => agregarBurbuja(rellenar(datos.sin_mas_ideas, perfil, ref)));
    mostrarBotones(["Quiero hablar con un especialista", ...datos.por_defecto.botones.slice(0, 4)]);
    registrar({ intencion: tema.id + "_sin_mas" });
  }
}

function revisarCodigoRojo(norm) {
  for (const cat of estado.datos.codigoRojo.categorias) {
    if (cat.frases.some((f) => coincide(norm, f))) return cat;
  }
  return null;
}

// Elige la intención del tipo pedido con más coincidencias; las frases largas pesan más.
function detectarIntencion(norm, tipo = "tema") {
  let mejor = null, puntos = 0;
  estado.datos.intenciones.intenciones
    .filter((it) => (it.tipo || "tema") === tipo)
    .forEach((it) => {
      const n = it.palabras.filter((p) => coincide(norm, p)).reduce((s, p) => s + tokens(p).length, 0);
      if (n > puntos) { mejor = it; puntos = n; }
    });
  // Para «sí» / «no»: solo si el mensaje es corto (evita que «no» dentro de una frase larga cuente como negación)
  if (tipo === "conversacion" && mejor && mejor.id !== "mas_info" && norm.split(" ").length > 6) return null;
  return mejor;
}

function detectarEmocion(norm) {
  const mapa = estado.datos.intenciones.emociones.palabras;
  for (const [palabra, emocion] of Object.entries(mapa)) {
    if (coincide(norm, palabra)) return emocion;
  }
  return null;
}

function mostrarProtocolo(categoria) {
  const p = estado.datos.codigoRojo.protocolo;
  const div = document.createElement("div");
  div.className = "alerta";
  div.setAttribute("role", "alert");
  div.innerHTML = `
    <div class="alerta-cabecera"><span class="alerta-icono" aria-hidden="true">!</span>Código Rojo · ${categoria.nombre}</div>
    <div class="alerta-cuerpo">
      <h3>${p.titulo}</h3>
      <p>${p.mensaje}</p>
      <ul class="recursos">
        ${p.recursos.map((r) => `<li><span><strong>${r.nombre}</strong><br><span class="muted">${r.detalle}</span></span><a class="tel" href="tel:${r.telefono.replace(/\s/g, "")}">${r.telefono}</a></li>`).join("")}
      </ul>
      <button type="button" class="btn-alerta">${p.boton_revision}</button>
    </div>`;
  const btn = div.querySelector(".btn-alerta");
  btn.addEventListener("click", () => {
    btn.disabled = true;
    btn.textContent = "Solicitud registrada";
    agregarBurbuja(p.confirmacion_revision);
    registrar({ intencion: "codigo_rojo", codigo_rojo: true, categoria: categoria.id, revision_humana: true });
  });
  contenedor().appendChild(div);
  bajarScroll();
  mostrarBotones(p.botones_despues || ["Gracias"]);
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
window.TE = { normalizar, coincide, revisarCodigoRojo, detectarIntencion, estado };
