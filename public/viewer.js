let selectedItemUrn = null;
let viewer = null;

let classificationData = {};
let currentSelectedDbIds = new Set();
let allModelDbIds = []; // Nuevo: para almacenar todos los dbIds del modelo y aplicar color inicial
const DEFAULT_GRAY_COLOR = new THREE.Vector4(0.8, 0.8, 0.8, 1); // Un gris más claro
const SELECTION_RED_COLOR = new THREE.Vector4(1, 0, 0, 0.8);    // R, G, B, Alpha para rojo (un poco transparente)


function login() {
    window.location.href = '/login';
}

async function loadHubs() {
    const res = await fetch('/api/hubs');
    const data = await res.json();

    const hubsSelect = document.getElementById('hubs');
    hubsSelect.innerHTML = '';

    data.data.forEach(hub => {
        const opt = document.createElement('option');
        opt.value = hub.id;
        opt.text = hub.attributes.name;
        hubsSelect.appendChild(opt);
    });

    hubsSelect.disabled = false;

    if (data.data.length > 0) {
        hubsSelect.value = data.data[0].id; // selecciona el primero
        loadProjects();
    }
}

async function loadProjects() {
    const hubId = document.getElementById('hubs').value;
    if (!hubId) {
        console.warn('No hay hub seleccionado');
        return;
    }
    try {
        const res = await fetch(`/api/projects/${hubId}`);
        const data = await res.json();

        const projectsSelect = document.getElementById('projects');
        projectsSelect.innerHTML = '';

        data.data.forEach(project => {
            const opt = document.createElement('option');
            opt.value = project.id;
            opt.text = project.attributes.name;
            projectsSelect.appendChild(opt);
        });

        projectsSelect.disabled = false;
    } catch (error) {
        console.error('Error cargando proyectos:', error);
    }
}

// Cargar hubs si ya está autenticado
window.onload = async () => {
    const res = await fetch('/api/check-auth');
    const authStatus = await res.json();
    if (authStatus.authenticated) {
        await loadHubs();
    }
};

async function loadRootFolder() {
    const hubId = document.getElementById('hubs').value;
    const projectId = document.getElementById('projects').value;
    if (!hubId || !projectId) return;

    try {
        const resProject = await fetch(`/api/project-details/${hubId}/${projectId}`);
        const projectData = await resProject.json();
        const rootFolderUrn = projectData.data.relationships.rootFolder.data.id;
        console.log('Root Folder URN:', rootFolderUrn);

        const container = document.getElementById('folderTree');
        container.innerHTML = '';
        await buildFolderTree(projectId, rootFolderUrn, container);

    } catch (error) {
        console.error('Error cargando root folder:', error);
    }
}

async function buildFolderTree(projectId, folderUrn, container) {
    try {
        const res = await fetch(`/api/folder-contents/${projectId}/${encodeURIComponent(folderUrn)}`);
        const data = await res.json();

        const ul = document.createElement('ul');

        data.data.forEach(item => {
            const li = document.createElement('li');
            li.textContent = item.attributes.displayName;

            if (item.type === 'folders') {
                li.classList.add('folder');
                li.addEventListener('click', async (e) => {
                    e.stopPropagation();

                    // Si ya está expandida, la colapsamos
                    if (li.querySelector('ul')) {
                        li.querySelector('ul').remove();
                    } else {
                        // Si no, cargamos sus hijos
                        await buildFolderTree(projectId, item.id, li);
                    }
                });
            } else if (item.type === 'items') {
                li.addEventListener('click', (e) => {
                    e.stopPropagation();  // Importante: evita que el clic en el archivo propague hacia carpetas padres

                    if (item.attributes.displayName.toLowerCase().endsWith('.rvt')) {
                        console.log('Archivo RVT seleccionado:', item);

                        selectedItemUrn = item.relationships?.tip?.data?.id;

                        document.getElementById('selectedFileName').value = item.attributes.displayName;
                        document.getElementById('analyzeButton').disabled = false;
                    } else {
                        console.log('Archivo no RVT ignorado:', item.attributes.displayName);
                    }
                });
            }

            ul.appendChild(li);
        });

        container.appendChild(ul);

    } catch (error) {
        console.error('Error cargando carpeta:', error);
    }
}

function base64EncodeURN(urn) {
    return btoa(urn).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}


// MODEL
document.getElementById('analyzeButton').addEventListener('click', async () => {
    if (!selectedItemUrn) {
        alert('No hay archivo RVT seleccionado');
        return;
    }

    try {
        console.log('Solicitando derivación para URN:', selectedItemUrn);

        const translateResponse = await fetch(`/api/translate?urn=${encodeURIComponent(selectedItemUrn)}`, {
            method: 'POST'
        });

        const translateResult = await translateResponse.json();
        console.log('Resultado de la derivación:', translateResult);

        // Opcional: Aquí puedes hacer polling para esperar a que el modelo termine la derivación antes de lanzarlo
        launchViewer(selectedItemUrn);

    } catch (error) {
        console.error('Error solicitando derivación:', error);
    }
});

async function launchViewer(urn) {
    if (!urn) {
        console.error('No URN especificado');
        return;
    }

    try {
        const options = {
            env: 'AutodeskProduction',
            getAccessToken: async (onTokenReady) => {
                const res = await fetch('/api/token');
                const tokenData = await res.json();
                onTokenReady(tokenData.access_token, tokenData.expires_in);
            }
        };

        Autodesk.Viewing.Initializer(options, () => {
            const viewerDiv = document.getElementById('forgeViewer');
            if (viewer) {
                viewer.finish();
                viewer = null;
                viewerDiv.innerHTML = '';
            }

            viewer = new Autodesk.Viewing.GuiViewer3D(viewerDiv);
            const startedCode = viewer.start();

            // *** MEJORA CLAVE: Añadir listeners para resize cuando el contenido esté listo ***
            viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, async () => {
                console.log('GEOMETRY_LOADED_EVENT disparado. Redimensionando visor y procesando propiedades.');
                viewer.resize();
                
                await initializeModelColors(); // NUEVA LLAMADA: Establece colores iniciales
                await processModelProperties(); // La lógica de propiedades existente
            });

            viewer.addEventListener(Autodesk.Viewing.VIEWER_STATE_RESTORED_EVENT, () => {
                console.log('VIEWER_STATE_RESTORED_EVENT disparado. Redimensionando visor.');
                viewer.resize();
            });

            // *** NUEVO: Escuchar cambios de selección en el visor ***
            viewer.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT, onViewerSelectionChanged);

            console.log('Viewer started:', startedCode);

            const documentId = 'urn:' + base64EncodeURN(urn);
            console.log('Lanzando Viewer con URN:', documentId);

            Autodesk.Viewing.Document.load(documentId, (doc) => {
                const defaultModel = doc.getRoot().getDefaultGeometry();
                viewer.loadDocumentNode(doc, defaultModel);
            }, (errorCode) => {
                console.error('Error cargando el documento:', errorCode);
            });
        });
    } catch (error) {
        console.error('Error lanzando el Viewer:', error);
    }
}

async function initializeModelColors() {
    if (!viewer || !viewer.model) {
        console.warn('Visor o modelo no disponibles para inicializar colores.');
        return;
    }

    allModelDbIds = [];
    const positionsMap = new Set();

    const tree = await new Promise(resolve => {
        viewer.model.getObjectTree(resolve);
    });

    tree.enumNodeChildren(tree.getRootId(), dbId => {
        const fragIds = [];
        viewer.model.getData().instanceTree.enumNodeFragments(dbId, fragId => {
            fragIds.push(fragId);
        });

        if (fragIds.length === 0) return;

        const fragList = viewer.model.getFragmentList();
        const box = new THREE.Box3();
        fragList.getWorldBounds(fragIds[0], box);

        const center = new THREE.Vector3();
        box.getCenter(center);

        const key = `${center.x.toFixed(3)}|${center.y.toFixed(3)}|${center.z.toFixed(3)}`;
        if (!positionsMap.has(key)) {
            positionsMap.add(key);
            allModelDbIds.push(dbId);
        }
    }, true);

    console.log(`[initializeModelColors] dbIds con posición única encontrados: ${allModelDbIds.length}`);

    // Color gris a todos
    allModelDbIds.forEach(dbId => {
        viewer.setThemingColor(dbId, DEFAULT_GRAY_COLOR, viewer.model, true);
    });

    viewer.impl.invalidate(true, true, true);
    viewer.setSelectionColor(new THREE.Color(1, 0, 0));
    console.log('Color de selección configurado a rojo.');
}

//COMENTARIO DE PRUEBA
// Función para procesar las propiedades del modelo y construir la lista de clasificación
async function processModelProperties() {
    console.log('--- processModelProperties INICIADO ---');
    if (!viewer || !viewer.model) {
        console.warn('[processModelProperties] Visor o modelo no disponible. Saliendo.');
        return;
    }

    classificationData = {};
    console.log('[processModelProperties] classificationData inicializada VACÍA.');

    function getPropertiesAsync(dbId) {
        return new Promise((resolve, reject) => {
            viewer.getProperties(dbId, resolve, reject);
        });
    }

    if (allModelDbIds.length === 0) {
        console.error('[processModelProperties] ERROR: allModelDbIds está vacío. La clasificación no puede continuar.');
        renderClassificationList();
        return;
    }

    console.log(`[processModelProperties] Iniciando procesamiento de propiedades para ${allModelDbIds.length} elementos.`);

    const groupedDbIds = new Set(); // ← Para registrar qué dbIds ya fueron agrupados
    let processedCount = 0;

    for (const dbId of allModelDbIds) {
        try {
            const props = await getPropertiesAsync(dbId);
            const properties = props.properties;
            
            const categoryProp = properties.find(p => p.displayName === 'Category');
            if (categoryProp && categoryProp.displayValue.includes('Type')) {
                continue; // Omitir tipos
            }

            let codigoPartida1Value = null;
            let descripcionPartida1Value = null;

            const codeProp = properties.find(p => p.displayName.trim().toUpperCase() === 'S&P_CODIGO PARTIDA N°1');
            if (codeProp) {
                codigoPartida1Value = (codeProp.displayValue || '').trim();
            }

            const descProp = properties.find(p => p.displayName.trim().toUpperCase() === 'S&P_DESCRIPCION PARTIDA N°1');
            if (descProp) {
                descripcionPartida1Value = (descProp.displayValue || '').trim();
            }

            // Solo clasificar si tiene un código válido
            if (codigoPartida1Value && codigoPartida1Value !== '') {
                const groupingKey = codigoPartida1Value;
                const displayGroupName = descripcionPartida1Value
                    ? `${codigoPartida1Value} - ${descripcionPartida1Value}`
                    : codigoPartida1Value;

                if (!classificationData[groupingKey]) {
                    classificationData[groupingKey] = {
                        dbIds: new Set(),
                        visible: true,
                        displayName: displayGroupName
                    };
                }

                classificationData[groupingKey].dbIds.add(dbId);
                groupedDbIds.add(dbId);
            }

        } catch (error) {
            console.error(`[processModelProperties] Error obteniendo propiedades para dbId ${dbId}:`, error);
        }

        processedCount++;
        if (processedCount % 1000 === 0) {
            console.log(`[processModelProperties] Progreso: ${processedCount}/${allModelDbIds.length} elementos procesados.`);
        }
    }

    // Identificar y agrupar los no clasificados
    const ungroupedDbIds = allModelDbIds.filter(id => !groupedDbIds.has(id));
    if (ungroupedDbIds.length > 0) {
        classificationData['SIN CÓDIGO'] = {
            dbIds: new Set(ungroupedDbIds),
            visible: true,
            displayName: 'SIN CÓDIGO'
        };
        console.log(`[processModelProperties] Elementos no clasificados agrupados en "SIN CÓDIGO": ${ungroupedDbIds.length}`);
    }

    console.log(`[processModelProperties] Procesamiento finalizado. Total de elementos procesados: ${processedCount}.`);
    console.log('Contenido final de classificationData:', classificationData);

    renderClassificationList();
    console.log('--- processModelProperties COMPLETADO ---');
}



// Maneja el clic en un elemento de la lista de clasificación
function onClassificationListItemClick(key) {
    const item = classificationData[key];
    if (!item || !viewer) return;

    // Restablecer el color de todos los elementos a gris antes de seleccionar
    viewer.clearThemingColors(); // Limpia cualquier color temático aplicado previamente
    allModelDbIds.forEach(dbId => {
        viewer.setThemingColor(dbId, DEFAULT_GRAY_COLOR, viewer.model, true);
    });

    viewer.clearSelection();
    currentSelectedDbIds.clear();

    const dbIdsArray = Array.from(item.dbIds);
    if (dbIdsArray.length > 0) {
        // Aplica el color de selección a los elementos
        dbIdsArray.forEach(dbId => {
            viewer.setThemingColor(dbId, SELECTION_RED_COLOR, viewer.model, true);
        });
        viewer.select(dbIdsArray); // Esto también los selecciona visualmente (cuadro azul por defecto)
        viewer.fitToView(dbIdsArray);
        dbIdsArray.forEach(id => currentSelectedDbIds.add(id));
    }
    viewer.impl.invalidate(true, true, true); // Forzar redibujado

    updateClassificationListSelection();
}

// Maneja el evento de cambio de selección en el visor 3D
function onViewerSelectionChanged(event) {
    // Restablecer el color de todos los elementos a gris
    viewer.clearThemingColors();
    allModelDbIds.forEach(dbId => {
        viewer.setThemingColor(dbId, DEFAULT_GRAY_COLOR, viewer.model, true);
    });

    currentSelectedDbIds = new Set(event.dbIdArray);

    // Aplicar color rojo a los elementos seleccionados
    currentSelectedDbIds.forEach(dbId => {
        viewer.setThemingColor(dbId, SELECTION_RED_COLOR, viewer.model, true);
    });
    viewer.impl.invalidate(true, true, true); // Forzar redibujado

    updateClassificationListSelection();
}

// Función para renderizar la lista de clasificación en el DOM
// Función para renderizar la lista de clasificación en el DOM
function renderClassificationList() {
    console.log('--- renderClassificationList INICIADO ---');
    const container = document.getElementById('classificationListContainer');
    container.innerHTML = ''; // Limpiar el contenedor

    const ul = document.createElement('ul');

    // Ordenar las claves alfabéticamente, pero "SIN CÓDIGO" al final
    const sortedKeys = Object.keys(classificationData).sort((a, b) => {
        if (a === 'SIN CÓDIGO') return 1; // 'SIN CÓDIGO' al final
        if (b === 'SIN CÓDIGO') return -1;
        return a.localeCompare(b);
    });

    if (sortedKeys.length === 0) { // Si no hay claves, o solo 'SIN CÓDIGO' vacío
        console.warn('[renderClassificationList] No hay datos de clasificación válidos para renderizar.');
        container.innerHTML = '<p>No se encontraron categorías de clasificación.</p>';
        console.log('--- renderClassificationList COMPLETADO (VACÍO) ---');
        return;
    }


    sortedKeys.forEach(key => {
        const item = classificationData[key];
        // Asegúrate de que el grupo tenga dbIds antes de renderizarlo (excepto 'SIN CÓDIGO' que puede ser útil vacío)
        if (item.dbIds.size === 0 && key !== 'SIN CÓDIGO') {
            return; // Saltar si no hay elementos en este grupo (y no es 'SIN CÓDIGO')
        }

        const li = document.createElement('li');
        // *** CAMBIO CLAVE AQUÍ: Usar item.displayName para el texto visible ***
        li.textContent = item.displayName || key; // Fallback a key si displayName no existe (no debería pasar)
        li.dataset.key = key; // Almacenar la clave de agrupación real para referencia

        const countSpan = document.createElement('span');
        countSpan.classList.add('count');
        countSpan.textContent = item.dbIds.size;
        li.appendChild(countSpan);

        li.addEventListener('click', () => onClassificationListItemClick(key));
        ul.appendChild(li);
    });

    container.appendChild(ul);
    console.log('Lista de clasificación renderizada:', classificationData);
    console.log('--- renderClassificationList COMPLETADO ---');
}

// Actualiza las clases 'selected' en los elementos de la lista en base a currentSelectedDbIds
function updateClassificationListSelection() {
    const listItems = document.querySelectorAll('#classificationListContainer li');
    listItems.forEach(li => {
        const key = li.dataset.key;
        const itemDbIds = classificationData[key]?.dbIds || new Set();
        
        // Verificar si TODOS los dbIds seleccionados en el viewer pertenecen a esta categoría
        // Y si esta categoría es la única seleccionada completamente
        let allSelectedBelongToThisCategory = true;
        let categoryIsCompletelySelected = true;

        if (currentSelectedDbIds.size === 0) {
            allSelectedBelongToThisCategory = false; // Nada seleccionado, ninguna categoría completa
        } else {
            // Verificar si todos los dbIds seleccionados en el viewer están en esta categoría
            for (const dbId of currentSelectedDbIds) {
                if (!itemDbIds.has(dbId)) {
                    allSelectedBelongToThisCategory = false;
                    break;
                }
            }

            // Verificar si esta categoría está completamente seleccionada (todos sus elementos)
            if (currentSelectedDbIds.size !== itemDbIds.size) {
                 categoryIsCompletelySelected = false;
            } else {
                for (const idOfCategory of itemDbIds) {
                    if (!currentSelectedDbIds.has(idOfCategory)) {
                        categoryIsCompletelySelected = false;
                        break;
                    }
                }
            }
        }
        
        // Aplica la clase 'selected' si la categoría está completamente seleccionada en el viewer
        // Simplificación: si todos los elementos seleccionados del viewer están en esta categoría y
        // no hay otros elementos seleccionados fuera de esta categoría, la marcamos.
        // Esto puede ser más complejo si permites selección múltiple de categorías.
        if (allSelectedBelongToThisCategory && categoryIsCompletelySelected && currentSelectedDbIds.size > 0) {
             li.classList.add('selected');
        } else {
             li.classList.remove('selected');
        }
    });
}

// Maneja el evento de cambio de selección en el visor 3D
function onViewerSelectionChanged(event) {
    // console.log('Selección en el visor ha cambiado:', event.dbIdArray);
    currentSelectedDbIds = new Set(event.dbIdArray); // Actualiza los IDs seleccionados
    updateClassificationListSelection();
}

window.addEventListener('resize', () => {
    if (viewer) viewer.resize();
});

