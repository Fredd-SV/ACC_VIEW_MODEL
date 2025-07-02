let viewer = null;
let classificationData = {};
let currentSelectedDbIds = new Set();
let allModelDbIds = [];
const DEFAULT_GRAY_COLOR = new THREE.Vector4(0.8, 0.8, 0.8, 1);
const SELECTION_RED_COLOR = new THREE.Vector4(1, 0, 0, 0.8);

let selectedItems = []; // [{urn, displayName}]
let previouslySelectedFileElement = null;
let previouslySelectedFolderElement = null;

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
        hubsSelect.value = data.data[0].id;
        loadProjects();
    }
}

async function loadProjects() {
    const hubId = document.getElementById('hubs').value;
    if (!hubId) return;

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

        const container = document.getElementById('folderTree');
        container.innerHTML = '';
        previouslySelectedFileElement = null;
        previouslySelectedFolderElement = null;
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
                    if (previouslySelectedFolderElement) {
                        previouslySelectedFolderElement.classList.remove('active-folder');
                    }
                    li.classList.add('active-folder');
                    previouslySelectedFolderElement = li;

                    if (previouslySelectedFileElement) {
                        previouslySelectedFileElement.classList.remove('selected-file');
                        previouslySelectedFileElement = null;
                    }

                    if (li.querySelector('ul')) {
                        li.querySelector('ul').remove();
                    } else {
                        await buildFolderTree(projectId, item.id, li);
                    }
                });
            } else if (item.type === 'items') {
                li.addEventListener('click', (e) => {
                    e.stopPropagation();

                    if (item.attributes.displayName.toLowerCase().endsWith('.rvt')) {
                        const urn = item.relationships?.tip?.data?.id;
                        if (!selectedItems.find(i => i.urn === urn)) {
                            selectedItems.push({ urn, name: item.attributes.displayName });

                            const option = document.createElement('option');
                            option.value = urn;
                            option.textContent = item.attributes.displayName;
                            document.getElementById('selectedFilesList').appendChild(option);

                            document.getElementById('analyzeButton').disabled = false;
                        }
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

document.getElementById('analyzeButton').addEventListener('click', async () => {
    if (selectedItems.length === 0) {
        alert('No hay archivos RVT seleccionados');
        return;
    }

    console.log('--- INICIANDO ANÁLISIS DE MODELOS ---');
    console.log('Modelos seleccionados:', selectedItems);

    classificationData = {};
    allModelDbIds = [];
    currentSelectedDbIds.clear();
    viewer?.clearThemingColors();

    await launchViewer();

    const loadPromises = [];

    for (const item of selectedItems) {
        console.log(`[1] Iniciando traducción para: ${item.name} (${item.urn})`);

        const response = await fetch(`/api/translate?urn=${encodeURIComponent(item.urn)}`, { method: 'POST' });
        const translateResult = await response.json();

        console.log(`[2] Resultado de /api/translate para ${item.name}:`, translateResult);

        const docId = 'urn:' + base64EncodeURN(item.urn);

        console.log(`[3] Cargando modelo en visor: ${docId}`);
        const loadPromise = loadModelIntoViewer(docId)
            .then(() => console.log(`[4] Modelo cargado exitosamente: ${item.name}`))
            .catch(err => console.error(`[ERROR] Fallo al cargar modelo ${item.name}:`, err));

        loadPromises.push(loadPromise);
    }

    await Promise.all(loadPromises);
    console.log('[5] Todos los modelos cargados');

    console.log('[6] Inicializando colores...');
    await initializeModelColors();
    console.log('[7] Colores aplicados');

    console.log('[8] Procesando propiedades para clasificación...');
    await processModelProperties();
    console.log('[9] Clasificación completada');

    console.log('--- FIN DEL ANÁLISIS DE MODELOS ---');
});

async function launchViewer() {
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
        viewer.start();
        viewer.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT, onViewerSelectionChanged);
    });
}

async function loadModelIntoViewer(documentId) {
    return new Promise((resolve, reject) => {
        Autodesk.Viewing.Document.load(documentId, (doc) => {
            const defaultModel = doc.getRoot().getDefaultGeometry();

            const model = viewer.loadDocumentNode(doc, defaultModel, {
                keepCurrentModels: true
            });

            const onGeometryLoaded = (event) => {
                if (event.model === model) {
                    viewer.removeEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, onGeometryLoaded);
                    resolve();
                }
            };

            viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, onGeometryLoaded);

            // Protección por timeout (opcional)
            setTimeout(() => {
                viewer.removeEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, onGeometryLoaded);
                resolve();
            }, 15000); // 15s máx
        }, (err) => {
            console.error('Error cargando modelo:', err);
            reject(err);
        });
    });
}



async function initializeModelColors() {
    if (!viewer) return;

    allModelDbIds = [];
    const positionsMap = new Set();

    const models = viewer.getVisibleModels();
    if (!models || models.length === 0) return;

    for (const model of models) {
        const tree = await new Promise(resolve => model.getObjectTree(resolve));
        tree.enumNodeChildren(tree.getRootId(), dbId => {
            const fragIds = [];
            model.getData().instanceTree.enumNodeFragments(dbId, fragId => fragIds.push(fragId));
            if (fragIds.length === 0) return;

            const fragList = model.getFragmentList();
            const box = new THREE.Box3();
            fragList.getWorldBounds(fragIds[0], box);

            const center = new THREE.Vector3();
            box.getCenter(center);
            const key = `${center.x.toFixed(3)}|${center.y.toFixed(3)}|${center.z.toFixed(3)}`;
            if (!positionsMap.has(key)) {
                positionsMap.add(key);
                allModelDbIds.push({ dbId, model });
            }
        }, true);
    }

    for (const { dbId, model } of allModelDbIds) {
        viewer.setThemingColor(dbId, DEFAULT_GRAY_COLOR, model, true);
    }

    viewer.impl.invalidate(true, true, true);
    viewer.setSelectionColor(new THREE.Color(1, 0, 0));
}


async function processModelProperties() {
    if (!viewer) return;

    classificationData = {};
    const groupedDbIds = new Set();

    function getPropertiesAsync(model, dbId) {
        return new Promise((resolve, reject) => model.getProperties(dbId, resolve, reject));
    }

    for (const { dbId, model } of allModelDbIds) {
        try {
            const props = await getPropertiesAsync(model, dbId);
            const properties = props.properties;

            const codeProp = properties.find(p => p.displayName.trim().toUpperCase() === 'S&P_CODIGO PARTIDA N°1');
            const descProp = properties.find(p => p.displayName.trim().toUpperCase() === 'S&P_DESCRIPCION PARTIDA N°1');

            const code = codeProp?.displayValue?.trim();
            const desc = descProp?.displayValue?.trim();

            if (code && code !== '') {
                const displayGroup = desc ? `${code} - ${desc}` : code;

                if (!classificationData[code]) {
                    classificationData[code] = {
                        dbIds: new Set(),
                        visible: true,
                        displayName: displayGroup
                    };
                }

                classificationData[code].dbIds.add({ dbId, model });
                groupedDbIds.add(`${dbId}-${model.id}`);
            }
        } catch (error) {
            console.error(`Error obteniendo propiedades para dbId ${dbId}:`, error);
        }
    }

    // Agregar elementos sin clasificar
    const allKeys = allModelDbIds.map(obj => `${obj.dbId}-${obj.model.id}`);
    const ungrouped = allModelDbIds.filter(obj => !groupedDbIds.has(`${obj.dbId}-${obj.model.id}`));
    if (ungrouped.length > 0) {
        classificationData['SIN CÓDIGO'] = {
            dbIds: new Set(ungrouped),
            visible: true,
            displayName: 'SIN CÓDIGO'
        };
    }

    renderClassificationList();
}


function renderClassificationList() {
    const container = document.getElementById('classificationListContainer');
    container.innerHTML = '';
    const ul = document.createElement('ul');

    const sortedKeys = Object.keys(classificationData).sort((a, b) => {
        if (a === 'SIN CÓDIGO') return 1;
        if (b === 'SIN CÓDIGO') return -1;
        return a.localeCompare(b);
    });

    sortedKeys.forEach(key => {
        const item = classificationData[key];
        const li = document.createElement('li');
        li.textContent = item.displayName || key;
        li.dataset.key = key;

        const countSpan = document.createElement('span');
        countSpan.classList.add('count');
        countSpan.textContent = item.dbIds.size;
        li.appendChild(countSpan);

        li.addEventListener('click', () => onClassificationListItemClick(key));
        ul.appendChild(li);
    });

    container.appendChild(ul);
}

/*
function onClassificationListItemClick(key) {
    const item = classificationData[key];
    if (!item || !viewer) return;

    viewer.clearThemingColors();

    // Restaurar todos los elementos a color gris
    for (const { dbId, model } of allModelDbIds) {
        viewer.setThemingColor(dbId, DEFAULT_GRAY_COLOR, model, true);
    }

    viewer.clearSelection();
    currentSelectedDbIds.clear();

    const dbIdsArray = Array.from(item.dbIds);

    // Agrupar dbIds por modelo
    const modelGroups = {};
    dbIdsArray.forEach(({ dbId, model }) => {
        currentSelectedDbIds.add(`${dbId}-${model.id}`);
        if (!modelGroups[model.id]) modelGroups[model.id] = [];
        modelGroups[model.id].push(dbId);
    });

    // Aplicar selección visual (resalte)
    Object.entries(modelGroups).forEach(([modelId, dbIds]) => {
        const model = viewer.impl.modelQueue().getModels().find(m => m.id == modelId);
        if (model && dbIds.length > 0) {
            viewer.select(dbIds, model);
            viewer.fitToView(dbIds, model); // También hacer zoom a la selección
        }
    });

    viewer.impl.invalidate(true, true, true);
    updateClassificationListSelection();
}


function onViewerSelectionChanged(event) {
    viewer.clearThemingColors();

    // Restaurar todos a gris
    for (const { dbId, model } of allModelDbIds) {
        viewer.setThemingColor(dbId, DEFAULT_GRAY_COLOR, model, true);
    }

    currentSelectedDbIds.clear();

    for (const model of viewer.getVisibleModels()) {
        const selection = viewer.getSelection(model);
        for (const dbId of selection) {
            viewer.setThemingColor(dbId, SELECTION_RED_COLOR, model, true);
            currentSelectedDbIds.add(`${dbId}-${model.id}`);
        }
    }

    viewer.impl.invalidate(true, true, true);
    updateClassificationListSelection();
}
*/

function onClassificationListItemClick(key) {
    const item = classificationData[key];
    if (!item || !viewer) return;

    viewer.clearThemingColors();
    allModelDbIds.forEach(({ dbId, model }) => {
        viewer.setThemingColor(dbId, DEFAULT_GRAY_COLOR, model, true);
    });

    viewer.clearSelection();
    currentSelectedDbIds.clear();

    const dbIdsArray = Array.from(item.dbIds);
    if (dbIdsArray.length > 0) {
        const modelGroups = {};

        dbIdsArray.forEach(({ dbId, model }) => {
            viewer.setThemingColor(dbId, SELECTION_RED_COLOR, model, true);
            currentSelectedDbIds.add(`${dbId}-${model.id}`);
            if (!modelGroups[model.id]) modelGroups[model.id] = [];
            modelGroups[model.id].push(dbId);
        });

        Object.entries(modelGroups).forEach(([modelId, dbIds]) => {
            const model = viewer.getVisibleModels().find(m => m.id == modelId);
            if (model) {
                viewer.select(dbIds, model);
                viewer.fitToView(dbIds, model);
            }
        });
    }

    viewer.impl.invalidate(true, true, true);
    updateClassificationListSelection();
}

function onViewerSelectionChanged(event) {
    viewer.clearThemingColors();
    allModelDbIds.forEach(({ dbId, model }) => {
        viewer.setThemingColor(dbId, DEFAULT_GRAY_COLOR, model, true);
    });

    currentSelectedDbIds.clear();

    for (const model of viewer.getVisibleModels()) {
        const selection = viewer.getSelection(model);
        for (const dbId of selection) {
            viewer.setThemingColor(dbId, SELECTION_RED_COLOR, model, true);
            currentSelectedDbIds.add(`${dbId}-${model.id}`);
        }
    }

    viewer.impl.invalidate(true, true, true);
    updateClassificationListSelection();
}



function updateClassificationListSelection() {
    const listItems = document.querySelectorAll('#classificationListContainer li');
    listItems.forEach(li => {
        const key = li.dataset.key;
        const itemDbIds = classificationData[key]?.dbIds || new Set();

        let allSelected = true;
        let sameSize = currentSelectedDbIds.size === itemDbIds.size;

        for (const { dbId, model } of itemDbIds) {
            if (!currentSelectedDbIds.has(`${dbId}-${model.id}`)) {
                allSelected = false;
                break;
            }
        }

        if (allSelected && sameSize && currentSelectedDbIds.size > 0) {
            li.classList.add('selected');
        } else {
            li.classList.remove('selected');
        }
    });
}


window.addEventListener('resize', () => {
    if (viewer) viewer.resize();
});

// Habilita eliminación manual al hacer doble clic sobre una opción del select multiple
const selectedFilesList = document.getElementById('selectedFilesList');
selectedFilesList.addEventListener('dblclick', (e) => {
    const selectedOption = e.target;
    if (selectedOption.tagName.toLowerCase() === 'option') {
        const urnToRemove = selectedOption.value;

        // Eliminar del array selectedItems
        selectedItems = selectedItems.filter(item => item.urn !== urnToRemove);

        // Eliminar del DOM
        selectedOption.remove();

        // Desactivar el botón si no hay archivos
        if (selectedItems.length === 0) {
            document.getElementById('analyzeButton').disabled = true;
        }
    }
});
