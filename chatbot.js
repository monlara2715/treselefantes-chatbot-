/* Treselefantes · Acompañante (prototipo v3)
 * Novedades v3: crear perfil desde cero, bitácora y Rueda de la Vida editables, fuentes en cada recomendación.
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
    fuentesMostradas: new Set(), // las fuentes de cada tema se muestran una vez por conversación
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

/* ---------- Perfiles propios (guardados en este navegador) ---------- */
// En la versión real esto vive en el servidor de Treselefantes, con consentimiento y cifrado.

const CLAVE_PERFILES = "treselefantes_perfiles";
const ETAPAS = {
  adulto: "Adultez",
  posparto: "Posparto",
  perimenopausia: "Perimenopausia",
  menopausia: "Menopausia",
  adulto_mayor: "Adulta/o mayor",
  docente: "Docente",
};
const DETONANTES = ["Ruido", "Prisas", "Cansancio", "Falta de sueño", "Trabajo", "Dinero", "Pareja", "Berrinches", "Tareas escolares", "Pantallas", "Peleas entre hermanos", "Salud"];
const DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

function leerPerfiles() {
  try { return JSON.parse(localStorage.getItem(CLAVE_PERFILES)) || []; } catch { return []; }
}
function guardarPerfiles(lista) {
  try { localStorage.setItem(CLAVE_PERFILES, JSON.stringify(lista)); } catch { /* sin almacenamiento */ }
}
function guardarPerfilActivo() {
  const p = estado.perfil;
  if (!p || !p.propio) return;
  const lista = leerPerfiles();
  const i = lista.findIndex((x) => x.id === p.id);
  if (i >= 0) lista[i] = p; else lista.push(p);
  guardarPerfiles(lista);
}

function hoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function diasEntre(isoA, isoB) {
  return Math.round((new Date(isoB + "T12:00") - new Date(isoA + "T12:00")) / 86400000);
}
function etiquetaDia(registro) {
  return registro.dia || DIAS[new Date(registro.fecha + "T12:00").getDay()];
}

// Días desde el último acceso: los perfiles propios lo calculan con la fecha real.
function diasSinEntrar(perfil) {
  if (!perfil.propio) return perfil.dias_desde_ultimo_acceso;
  return perfil.ultimo_acceso ? diasEntre(perfil.ultimo_acceso, hoyISO()) : 0;
}

function descripcionPerfil(p) {
  if (p.rol === "docente") return p.grupo ? `Docente · ${p.grupo.nombre}` : "Docente";
  const n = p.hijos.length;
  const edades = p.hijos.map((h) => h.edad).join(", ");
  return `${p.edad ? p.edad + " años · " : ""}${n} ${n === 1 ? "niña/o" : "niñas/os"}${n ? ` de ${edades}` : ""}`;
}

/* ---------- Pantalla de perfiles ---------- */

function mostrarPantalla(id) {
  ["pantalla-perfiles", "pantalla-registro", "pantalla-chat"].forEach((p) => (document.getElementById(p).hidden = p !== id));
  window.scrollTo(0, 0);
}

function tarjetaPerfil(p, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tarjeta-perfil";
  const conDatos = p.bitacora.length;
  const estresProm = conDatos ? promedio(p.bitacora.map((d) => d.estres)).toFixed(1) + " de 5" : "sin registros";
  const dias = diasSinEntrar(p);
  btn.innerHTML = `
    <span class="rol">${p.rol === "docente" ? "Docente" : "Familia"}</span>
    <h2>${escapar(p.nombre)}</h2>
    <span>${escapar(p.descripcion || descripcionPerfil(p))}</span>
    <span class="dato">Estrés promedio: ${estresProm} · Último acceso: ${textoAcceso(dias)}</span>`;
  btn.addEventListener("click", onClick);
  return btn;
}

function mostrarPerfiles() {
  const propios = document.getElementById("lista-propios");
  propios.innerHTML = "";
  leerPerfiles().forEach((p) => propios.appendChild(tarjetaPerfil(p, () => iniciarChat(p))));
  const crear = document.createElement("button");
  crear.type = "button";
  crear.className = "tarjeta-perfil tarjeta-crear";
  crear.innerHTML = `<span class="mas" aria-hidden="true">+</span><h2>Crear mi perfil</h2><span>Toma 2 minutos: tus datos, tu familia y tu Rueda de la Vida.</span>`;
  crear.addEventListener("click", () => abrirRegistro());
  propios.appendChild(crear);

  const lista = document.getElementById("lista-perfiles");
  lista.innerHTML = "";
  estado.datos.usuarios.perfiles.forEach((p) => lista.appendChild(tarjetaPerfil(p, () => iniciarChat(p))));
  mostrarPantalla("pantalla-perfiles");
}

function promedio(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function textoAcceso(dias) {
  if (dias === 0) return "hoy";
  if (dias === 1) return "ayer";
  return `hace ${dias} días`;
}

function escapar(t) {
  return String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- Registro: crear o editar perfil ---------- */

const registro = { paso: 1, editando: null };

function abrirRegistro(perfil = null) {
  registro.paso = 1;
  registro.editando = perfil;
  const f = document.getElementById("form-registro");
  f.reset();
  document.getElementById("registro-titulo").textContent = perfil ? "Edita tu perfil" : "Crea tu perfil";
  document.getElementById("lista-hijos").innerHTML = "";
  document.getElementById("registro-error").hidden = true;

  if (perfil) {
    document.getElementById("reg-nombre").value = perfil.nombre;
    f.querySelector(`input[name=rol][value=${perfil.rol}]`).checked = true;
    document.getElementById("reg-edad").value = perfil.edad || "";
    if (perfil.etapa_cuidador !== "docente") document.getElementById("reg-etapa").value = perfil.etapa_cuidador;
    document.getElementById("reg-consentimiento").checked = true;
    perfil.hijos.forEach((h) => agregarFilaHijo(h));
    if (perfil.grupo) {
      document.getElementById("reg-grupo").value = perfil.grupo.nombre;
      document.getElementById("reg-gmin").value = perfil.grupo.edad_min;
      document.getElementById("reg-gmax").value = perfil.grupo.edad_max;
    }
  }
  if (!document.querySelector("#lista-hijos .fila-hijo")) agregarFilaHijo();
  pintarEditorRueda(document.getElementById("reg-rueda"), perfil ? perfil.rueda : null, "reg");
  actualizarRol();
  mostrarPaso();
  mostrarPantalla("pantalla-registro");
  document.getElementById("reg-nombre").focus();
}

let contadorHijos = 0;
function agregarFilaHijo(h = {}) {
  contadorHijos++;
  const fila = document.createElement("div");
  fila.className = "fila-hijo";
  fila.innerHTML = `
    <div class="campo">
      <label for="hijo-nombre-${contadorHijos}">Nombre o apodo</label>
      <input id="hijo-nombre-${contadorHijos}" class="hijo-nombre" type="text" maxlength="30" value="${escapar(h.nombre || "")}" placeholder="Ej. Mateo">
    </div>
    <div class="campo campo-corto">
      <label for="hijo-edad-${contadorHijos}">Edad</label>
      <input id="hijo-edad-${contadorHijos}" class="hijo-edad" type="number" min="0" max="18" value="${h.edad ?? ""}" placeholder="0–18">
    </div>
    <button type="button" class="btn-quitar" aria-label="Quitar">×</button>`;
  fila.querySelector(".btn-quitar").addEventListener("click", () => {
    if (document.querySelectorAll("#lista-hijos .fila-hijo").length > 1) fila.remove();
  });
  document.getElementById("lista-hijos").appendChild(fila);
}

function rolElegido() {
  return document.querySelector("#form-registro input[name=rol]:checked").value;
}

function actualizarRol() {
  const docente = rolElegido() === "docente";
  document.getElementById("campo-etapa").hidden = docente;
  document.getElementById("bloque-hijos").hidden = docente;
  document.getElementById("bloque-grupo").hidden = !docente;
  document.getElementById("leyenda-familia").textContent = docente ? "Tu grupo" : "Tu familia";
  document.querySelector('.pasos li[data-paso="2"]').textContent = docente ? "Tu grupo" : "Tu familia";
}

function mostrarPaso() {
  document.querySelectorAll("#form-registro .paso").forEach((p) => (p.hidden = Number(p.dataset.paso) !== registro.paso));
  document.querySelectorAll(".pasos li").forEach((li) => {
    const n = Number(li.dataset.paso);
    li.classList.toggle("activo", n === registro.paso);
    li.classList.toggle("hecho", n < registro.paso);
  });
  document.getElementById("btn-reg-atras").textContent = registro.paso === 1 ? "Cancelar" : "Atrás";
  document.getElementById("btn-reg-siguiente").textContent = registro.paso === 3 ? (registro.editando ? "Guardar cambios" : "Crear mi perfil") : "Siguiente";
  document.getElementById("registro-error").hidden = true;
}

function errorRegistro(msg) {
  const e = document.getElementById("registro-error");
  e.textContent = msg;
  e.hidden = false;
}

function validarPaso() {
  if (registro.paso === 1) {
    if (!document.getElementById("reg-nombre").value.trim()) return "Escribe tu nombre o un apodo para continuar.";
    if (!document.getElementById("reg-consentimiento").checked) return "Para continuar necesitamos tu consentimiento sobre el uso de tus datos.";
  }
  if (registro.paso === 2) {
    if (rolElegido() === "docente") {
      const min = Number(document.getElementById("reg-gmin").value), max = Number(document.getElementById("reg-gmax").value);
      if (!document.getElementById("reg-grupo").value.trim()) return "Escribe el nombre de tu grupo.";
      if (!(min >= 0 && max <= 18 && min <= max && document.getElementById("reg-gmax").value !== "")) return "Revisa las edades del grupo: deben ir de 0 a 18 y la mínima no puede ser mayor que la máxima.";
    } else {
      const filas = [...document.querySelectorAll("#lista-hijos .fila-hijo")];
      const validas = filas.filter((f) => f.querySelector(".hijo-nombre").value.trim() && f.querySelector(".hijo-edad").value !== "");
      if (!validas.length) return "Agrega al menos a una niña o niño con su nombre y edad.";
      if (validas.some((f) => { const e = Number(f.querySelector(".hijo-edad").value); return e < 0 || e > 18; })) return "Las edades deben ir de 0 a 18 años.";
    }
  }
  return null;
}

function construirPerfil() {
  const docente = rolElegido() === "docente";
  const base = registro.editando || {
    id: "propio-" + Date.now().toString(36),
    propio: true,
    bitacora: [],
    creado: hoyISO(),
    ultimo_acceso: hoyISO(),
  };
  const p = { ...base };
  p.nombre = document.getElementById("reg-nombre").value.trim();
  p.rol = docente ? "docente" : "familia";
  p.edad = Number(document.getElementById("reg-edad").value) || null;
  p.etapa_cuidador = docente ? "docente" : document.getElementById("reg-etapa").value;
  p.etapa_texto = ETAPAS[p.etapa_cuidador];
  p.hijos = docente ? [] : [...document.querySelectorAll("#lista-hijos .fila-hijo")]
    .map((f) => ({ nombre: f.querySelector(".hijo-nombre").value.trim(), edad: Number(f.querySelector(".hijo-edad").value) }))
    .filter((h) => h.nombre && !Number.isNaN(h.edad));
  p.grupo = docente ? {
    nombre: document.getElementById("reg-grupo").value.trim(),
    edad_min: Number(document.getElementById("reg-gmin").value),
    edad_max: Number(document.getElementById("reg-gmax").value),
  } : null;
  p.rueda = leerEditorRueda(document.getElementById("reg-rueda"));
  p.descripcion = descripcionPerfil(p);
  return p;
}

function enviarRegistro(e) {
  e.preventDefault();
  const error = validarPaso();
  if (error) return errorRegistro(error);
  if (registro.paso < 3) {
    registro.paso++;
    mostrarPaso();
    return;
  }
  const perfil = construirPerfil();
  const lista = leerPerfiles();
  const i = lista.findIndex((x) => x.id === perfil.id);
  if (i >= 0) lista[i] = perfil; else lista.push(perfil);
  guardarPerfiles(lista);
  iniciarChat(perfil, { nuevo: !registro.editando });
}

function atrasRegistro() {
  if (registro.paso > 1) {
    registro.paso--;
    mostrarPaso();
  } else if (registro.editando) {
    iniciarChat(registro.editando);
  } else {
    mostrarPerfiles();
  }
}

/* ---------- Editores: Rueda de la Vida y bitácora ---------- */

function pintarEditorRueda(contenedorEditor, valores, prefijo) {
  const areas = estado.datos.usuarios.areas_rueda;
  contenedorEditor.innerHTML = areas.map((a, i) => {
    const v = valores ? valores[a] : 5;
    return `<div class="rueda-fila">
      <label for="${prefijo}-rueda-${i}">${a}</label>
      <input id="${prefijo}-rueda-${i}" type="range" min="1" max="10" step="1" value="${v}" data-area="${a}">
      <output for="${prefijo}-rueda-${i}">${v}</output>
    </div>`;
  }).join("");
  contenedorEditor.querySelectorAll("input[type=range]").forEach((r) =>
    r.addEventListener("input", () => (r.nextElementSibling.textContent = r.value))
  );
}

function leerEditorRueda(contenedorEditor) {
  const r = {};
  contenedorEditor.querySelectorAll("input[type=range]").forEach((i) => (r[i.dataset.area] = Number(i.value)));
  return r;
}

function pintarEscala(cont, valorInicial) {
  const campo = cont.dataset.campo;
  cont.innerHTML = [1, 2, 3, 4, 5].map((n) => `
    <label class="punto"><input type="radio" name="bit-${campo}" value="${n}" ${n === valorInicial ? "checked" : ""}><span>${n}</span></label>`).join("");
}

function abrirBitacora() {
  const p = estado.perfil;
  const hoy = p.bitacora.find((r) => r.fecha === hoyISO());
  document.getElementById("bitacora-fecha").textContent =
    new Date().toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" }) + (hoy ? " · ya tienes un registro hoy; puedes actualizarlo" : "");
  document.querySelectorAll("#dlg-bitacora .escala").forEach((c) => pintarEscala(c, hoy ? hoy[c.dataset.campo] : 3));
  const elegidos = hoy ? hoy.detonantes.map((d) => d.toLowerCase()) : [];
  document.getElementById("bitacora-detonantes").innerHTML = DETONANTES.map((d, i) => `
    <label class="chip-check"><input type="checkbox" id="det-${i}" value="${d}" ${elegidos.includes(d.toLowerCase()) ? "checked" : ""}><span>${d}</span></label>`).join("");
  const extra = hoy ? hoy.detonantes.filter((d) => !DETONANTES.map((x) => x.toLowerCase()).includes(d.toLowerCase())) : [];
  document.getElementById("bitacora-otro").value = extra.join(", ");
  document.getElementById("bitacora-nota").value = hoy?.nota || "";
  document.getElementById("dlg-bitacora").showModal();
}

async function guardarBitacora(e) {
  e.preventDefault();
  const dlg = document.getElementById("dlg-bitacora");
  const energia = Number(dlg.querySelector("input[name=bit-energia]:checked")?.value || 3);
  const estres = Number(dlg.querySelector("input[name=bit-estres]:checked")?.value || 3);
  const detonantes = [...dlg.querySelectorAll("#bitacora-detonantes input:checked")].map((i) => i.value.toLowerCase());
  const otro = document.getElementById("bitacora-otro").value.trim();
  if (otro) otro.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).forEach((x) => detonantes.push(x));
  const registroDia = { fecha: hoyISO(), energia, estres, detonantes, nota: document.getElementById("bitacora-nota").value.trim() };

  const p = estado.perfil;
  if (!p.propio) {
    // Perfiles de ejemplo: el registro de hoy reemplaza al día más antiguo (solo en esta sesión)
    if (p.bitacora.length && !p.bitacora[p.bitacora.length - 1].fecha) p.bitacora.shift();
  }
  const i = p.bitacora.findIndex((r) => r.fecha === registroDia.fecha);
  if (i >= 0) p.bitacora[i] = registroDia; else p.bitacora.push(registroDia);
  p.bitacora = p.bitacora.slice(-60);
  guardarPerfilActivo();
  dlg.close();
  pintarPanel(p);
  registrar({ intencion: "bitacora_llenada" });
  await reaccionarBitacora(registroDia);
}

// El acompañante comenta el registro del día y propone un tema relacionado.
async function reaccionarBitacora(r) {
  const ctx = estado.ctx;
  let texto, tema = null;
  const det = r.detonantes[0];
  if (r.estres >= 4) {
    texto = `Gracias por registrarlo. Hoy marcaste estrés de ${r.estres} de 5${det ? ` y «${det}» como detonante` : ""}. ¿Quieres que veamos algo para bajarlo un poco?`;
    tema = det === "ruido" ? "ruido" : det === "berrinches" ? "berrinches" : det === "pareja" ? "pareja" : "estres";
  } else if (r.energia <= 2) {
    texto = `Gracias por registrarlo. Tu energía está baja hoy (${r.energia} de 5). ¿Te comparto ideas pequeñas para recargar?`;
    tema = "tiempo_para_mi";
  } else {
    texto = `¡Listo! Tu día se ve bastante bien: energía ${r.energia} y estrés ${r.estres} de 5. Me da gusto. ¿Hay algo en lo que te pueda acompañar?`;
  }
  ctx.temaPendiente = tema;
  await conEscribiendo(() => agregarBurbuja(texto));
  mostrarBotones(tema ? ["Sí", "Ahorita no"] : ["Me siento estresada/o", "Berrinches", "Problemas para dormir"]);
}

async function guardarRueda(e) {
  e.preventDefault();
  const p = estado.perfil;
  p.rueda = leerEditorRueda(document.getElementById("editor-rueda"));
  guardarPerfilActivo();
  document.getElementById("dlg-rueda").close();
  pintarPanel(p);
  registrar({ intencion: "rueda_actualizada" });
  await conEscribiendo(() => agregarBurbuja(`Actualicé tu Rueda de la Vida. Tu área más baja ahora es «${areaMasBaja(p)}». ¿Quieres ideas para cuidarla?`));
  estado.ctx.temaPendiente = "tiempo_para_mi";
  mostrarBotones(["Sí", "Ahorita no"]);
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
  estado.crucesPerfil = crucesDelPerfil(perfil);
  document.getElementById("perfil-nombre").textContent = perfil.nombre;
  document.getElementById("perfil-descripcion").textContent = perfil.descripcion || descripcionPerfil(perfil);
  document.getElementById("perfil-etapa").textContent = perfil.etapa_texto;
  document.getElementById("bloque-privacidad").hidden = !perfil.propio;
  document.getElementById("confirmar-borrado").hidden = true;

  const hijos = document.getElementById("perfil-hijos");
  hijos.innerHTML = "";
  if (perfil.hijos.length) {
    perfil.hijos.forEach((h) => (hijos.innerHTML += `<li>${escapar(h.nombre)}, ${h.edad} ${h.edad === 1 ? "año" : "años"}</li>`));
  } else if (perfil.grupo) {
    hijos.innerHTML = `<li>${escapar(perfil.grupo.nombre)} (${perfil.grupo.edad_min}–${perfil.grupo.edad_max} años)</li>`;
  }

  // Gráfica de barras del estrés (1 a 5) de los últimos 7 registros
  const ultimos = perfil.bitacora.slice(-7);
  const grafica = document.getElementById("grafica-estres");
  if (!ultimos.length) {
    grafica.innerHTML = `<p class="vacio">Aún no hay registros. Llena tu bitácora de hoy para empezar a ver tu semana.</p>`;
  } else {
    const ancho = 280, alto = 96, base = 78, paso = ancho / 7;
    let barras = "";
    ultimos.forEach((d, i) => {
      const h = (d.estres / 5) * 64;
      const x = i * paso + paso * 0.2;
      barras += `<rect class="barra ${d.estres >= 4 ? "alta" : ""}" x="${x}" y="${base - h}" width="${paso * 0.6}" height="${h}" rx="3"><title>${etiquetaDia(d)}: estrés ${d.estres} de 5, energía ${d.energia} de 5</title></rect>`;
      barras += `<text x="${x + paso * 0.3}" y="${base + 14}" text-anchor="middle">${etiquetaDia(d)}</text>`;
    });
    grafica.innerHTML = `<svg viewBox="0 0 ${ancho} ${alto}" role="img" aria-label="Estrés de los últimos registros">${barras}</svg><p class="leyenda-grafica">Estrés por día (1 a 5)</p>`;
  }
  const llenoHoy = perfil.bitacora.some((r) => r.fecha === hoyISO());
  document.getElementById("btn-bitacora").textContent = llenoHoy ? "Editar hoy" : "Llenar hoy";

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

// ¿Todas las áreas de la Rueda tienen el mismo valor? (entonces no hay un «área más baja» real)
function ruedaPareja(perfil) {
  const v = Object.values(perfil.rueda);
  return Math.min(...v) === Math.max(...v);
}

function borrarPerfil() {
  const id = estado.perfil.id;
  guardarPerfiles(leerPerfiles().filter((p) => p.id !== id));
  try {
    const reg = JSON.parse(localStorage.getItem(CLAVE_REGISTRO)) || [];
    localStorage.setItem(CLAVE_REGISTRO, JSON.stringify(reg.filter((r) => r.perfil !== id)));
  } catch { /* sin almacenamiento */ }
  estado.perfil = null;
  mostrarPerfiles();
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

const ICONO_FUENTE = { guia: "Guía", investigacion: "Información de salud", video: "Videos" };

// Bloque «Para saber más» con las fuentes de un tema o de una regla de cruce.
function agregarFuentes(ids = []) {
  const catalogo = estado.datos.intenciones.fuentes || {};
  const fuentes = ids.map((id) => catalogo[id]).filter(Boolean);
  if (!fuentes.length) return;
  const div = document.createElement("div");
  div.className = "fuentes";
  div.innerHTML = `<span class="fuentes-titulo">Para saber más</span><ul>${fuentes.map((f) => `
    <li><a href="${f.url}" target="_blank" rel="noopener noreferrer">
      <span class="fuente-tipo tipo-${f.tipo}">${ICONO_FUENTE[f.tipo] || "Fuente"}</span>
      <span class="fuente-texto"><strong>${escapar(f.titulo)}</strong><span>${escapar(f.organizacion)}</span></span>
    </a></li>`).join("")}</ul>`;
  contenedor().appendChild(div);
  bajarScroll();
}

function agregarTip(regla) {
  const div = document.createElement("div");
  div.className = "burbuja tip";
  div.innerHTML = `<strong>Para tu etapa: ${regla.titulo}</strong>${regla.explicacion} ${regla.recomendacion}`;
  contenedor().appendChild(div);
  bajarScroll();
  if (regla.fuentes) agregarFuentes(regla.fuentes);
}

// Botones especiales que abren una ventana en lugar de enviar un mensaje
const ACCIONES_BOTON = {
  "Llenar mi bitácora ahora": () => abrirBitacora(),
  "Actualizar mi Rueda": () => abrirRueda(),
};

function mostrarBotones(lista = []) {
  const zona = document.getElementById("botones-rapidos");
  zona.innerHTML = "";
  lista.forEach((texto) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = texto;
    b.addEventListener("click", () => (ACCIONES_BOTON[texto] ? ACCIONES_BOTON[texto]() : procesarMensaje(texto)));
    zona.appendChild(b);
  });
}

function abrirRueda() {
  pintarEditorRueda(document.getElementById("editor-rueda"), estado.perfil.rueda, "dlg");
  document.getElementById("dlg-rueda").showModal();
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

async function iniciarChat(perfil, opciones = {}) {
  // Los perfiles de ejemplo se copian para que los cambios de la sesión no toquen los datos originales
  estado.perfil = perfil.propio ? perfil : JSON.parse(JSON.stringify(perfil));
  perfil = estado.perfil;
  const diasFuera = diasSinEntrar(perfil);
  if (perfil.propio) {
    perfil.ultimo_acceso = hoyISO();
    guardarPerfilActivo();
  }
  estado.ctx = nuevoContexto();
  mostrarPantalla("pantalla-chat");
  document.getElementById("barra-emergencia").classList.remove("activa");
  contenedor().innerHTML = "";
  mostrarBotones([]);
  pintarPanel(perfil);

  // Perfil recién creado o sin registros: invitar a la primera bitácora
  if (!perfil.bitacora.length) {
    const hijos = perfil.hijos.map((h) => h.nombre);
    const quien = perfil.rol === "docente" ? `tu grupo ${perfil.grupo?.nombre || ""}`.trim()
      : hijos.length > 1 ? `${hijos.slice(0, -1).join(", ")} y ${hijos.at(-1)}` : hijos[0] || "tu familia";
    const saludoNuevo = opciones.nuevo
      ? `¡Bienvenida/o, ${perfil.nombre}! Ya tengo tu perfil y el de ${quien}. ${ruedaPareja(perfil) ? "" : `Tu área más baja en la Rueda de la Vida es «${areaMasBaja(perfil)}». `}Para acompañarte mejor, ¿llenamos tu primera bitácora? Toma menos de un minuto.`
      : `Hola, ${perfil.nombre}. Todavía no tienes registros en tu bitácora. ¿La llenamos hoy? Toma menos de un minuto.`;
    await conEscribiendo(() => agregarBurbuja(saludoNuevo));
    const cruce = estado.crucesPerfil.find((c) => c.temas.includes("saludo_inicial"));
    if (cruce) {
      estado.ctx.crucesMostrados.add(cruce.id);
      await conEscribiendo(() => agregarTip(cruce), 450);
    }
    mostrarBotones(["Llenar mi bitácora ahora", "Me siento estresada/o", "Berrinches", "¿Qué es el Oráculo?"]);
    document.getElementById("campo-mensaje").focus();
    return;
  }

  // Saludo con contexto según la bitácora. Deja un tema "pendiente" para que un «sí» tenga sentido.
  const ultimos3 = perfil.bitacora.slice(-3);
  const estresAlto = ultimos3.filter((d) => d.estres >= 4).length;
  const energiaProm = promedio(perfil.bitacora.slice(-7).map((d) => d.energia));
  const frecuente = masFrecuente(perfil.bitacora.slice(-7).flatMap((d) => d.detonantes));

  let saludo = `Hola, ${perfil.nombre}.`;
  if (estresAlto >= 2) {
    saludo += ` Veo en tu bitácora que tu estrés ha estado alto en ${estresAlto} de tus últimos 3 registros${frecuente ? `, y que «${frecuente}» aparece seguido como detonante` : ""}. ¿Quieres que platiquemos de eso?`;
    estado.ctx.temaPendiente = frecuente === "ruido" ? "ruido" : "estres";
  } else if (energiaProm < 2.5) {
    saludo += ` Esta semana tu energía ha estado baja (${energiaProm.toFixed(1)} de 5 en promedio). ¿Quieres que veamos cómo recuperar un poco de energía?`;
    estado.ctx.temaPendiente = "estres";
  } else if (perfil.rol === "docente") {
    saludo += ` Tu semana se ve bastante estable${frecuente ? `, aunque «${frecuente}» aparece en tu bitácora` : ""}. ¿Quieres que platiquemos de tu grupo?`;
    estado.ctx.temaPendiente = "grupo";
  } else {
    saludo += ` Tu semana se ve bastante estable. Tu área más baja en la Rueda de la Vida es «${areaMasBaja(perfil)}». ¿Quieres ideas para cuidarla?`;
    estado.ctx.temaPendiente = "tiempo_para_mi";
  }

  await conEscribiendo(() => agregarBurbuja(saludo));

  // Recordatorio de continuidad (usuario activo = 3 veces por semana)
  const llenoHoy = perfil.bitacora.some((r) => r.fecha === hoyISO());
  if (diasFuera > 3) {
    await conEscribiendo(() =>
      agregarBurbuja(
        `Por cierto, hace ${diasFuera} días que no te veía por aquí. Cuando puedas, llena tu bitácora: toma menos de un minuto y me ayuda a acompañarte mejor.`,
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

  const extra = llenoHoy ? [] : ["Llenar mi bitácora ahora"];
  mostrarBotones(
    perfil.rol === "docente"
      ? ["Sí", ...extra, "Conflicto en el grupo", "Me siento estresada/o"]
      : ["Sí", ...extra, "Problemas para dormir", "Berrinches"]
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
  if (tema.fuentes && !ctx.fuentesMostradas.has(tema.id)) {
    ctx.fuentesMostradas.add(tema.id);
    agregarFuentes(tema.fuentes);
  }

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
document.getElementById("form-registro").addEventListener("submit", enviarRegistro);
document.getElementById("btn-reg-atras").addEventListener("click", atrasRegistro);
document.getElementById("btn-agregar-hijo").addEventListener("click", () => agregarFilaHijo());
document.querySelectorAll("#form-registro input[name=rol]").forEach((r) => r.addEventListener("change", actualizarRol));
document.getElementById("btn-bitacora").addEventListener("click", abrirBitacora);
document.getElementById("btn-rueda").addEventListener("click", abrirRueda);
document.getElementById("form-bitacora").addEventListener("submit", guardarBitacora);
document.getElementById("form-rueda").addEventListener("submit", guardarRueda);
document.querySelectorAll("dialog [data-cerrar]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
document.getElementById("btn-editar-perfil").addEventListener("click", () => abrirRegistro(estado.perfil));
document.getElementById("btn-borrar-perfil").addEventListener("click", () => (document.getElementById("confirmar-borrado").hidden = false));
document.getElementById("btn-borrar-no").addEventListener("click", () => (document.getElementById("confirmar-borrado").hidden = true));
document.getElementById("btn-borrar-si").addEventListener("click", borrarPerfil);
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
window.TE = { normalizar, coincide, revisarCodigoRojo, detectarIntencion, estado, leerPerfiles };
