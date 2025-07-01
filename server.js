require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const cors = require('cors');
const morgan = require('morgan');
const app = express();
const cookieParser = require('cookie-parser');

app.use(cookieParser());
app.use(cors());
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));


const scopes = [
    'data:read',
    'data:write',
    'data:create',
    'bucket:create',
    'bucket:read',
    'viewables:read'
].join(' ');

// Sirve index.html en la raíz
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Ruta /login
app.get('/login', (req, res) => {
    const authUrl = `https://developer.api.autodesk.com/authentication/v2/authorize?response_type=code&client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}`;
    res.redirect(authUrl);
});


// Callback OAuth
app.get('/api/auth/callback', async (req, res) => {
    const code = req.query.code;

    if (code) {
        try {
            const tokenResponse = await axios.post(
                'https://developer.api.autodesk.com/authentication/v2/token',
                `code=${code}&grant_type=authorization_code&client_id=${process.env.CLIENT_ID}&client_secret=${process.env.CLIENT_SECRET}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}`,
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                }
            );

            const accessToken = tokenResponse.data.access_token;

            res.cookie('access_token', accessToken, { httpOnly: true });
            res.redirect('/');
        } catch (error) {
            console.error('Error obteniendo token:', error.response?.data || error.message);
            res.status(500).send('Error al autenticarse');
        }
    } else {
        console.log('No hay codigo');
        // Si no hay code, solo carga el index.html normal
        res.sendFile(__dirname + '/public/index.html');
    }
});

//
app.get('/api/check-auth', (req, res) => {
    const token = req.cookies.access_token;
    if (token) {
        res.json({ authenticated: true });
    } else {
        res.json({ authenticated: false });
    }
})

// Ruta para obtener hubs
app.get('/api/hubs', async (req, res) => {
    const token = req.cookies.access_token;
    try {
        const response = await axios.get('https://developer.api.autodesk.com/project/v1/hubs', {
            headers: { Authorization: `Bearer ${token}` }
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error obteniendo hubs:', error.response?.data || error.message);
        res.status(500).json({ error: 'No se pudieron cargar los hubs' });
    }
});

// Ruta para obtener proyectos por hub
app.get('/api/projects/:hubId', async (req, res) => {
    const token = req.cookies.access_token;
    const hubId = req.params.hubId;
    try {
        const response = await axios.get(`https://developer.api.autodesk.com/project/v1/hubs/${hubId}/projects`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error obteniendo proyectos:', error.response?.data || error.message);
        res.status(500).json({ error: 'No se pudieron cargar los proyectos' });
    }
});




// Obtener detalles del proyecto para rootFolder
app.get('/api/project-details/:hubId/:projectId', async (req, res) => {
    const token = req.cookies.access_token;
    const { hubId, projectId } = req.params;
    try {
        const response = await axios.get(`https://developer.api.autodesk.com/project/v1/hubs/${hubId}/projects/${projectId}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error obteniendo detalles del proyecto:', error.response?.data || error.message);
        res.status(500).json({ error: 'No se pudieron obtener detalles del proyecto' });
    }
});

// Obtener contenido de carpeta (folders + items dentro)
app.get('/api/folder-contents/:projectId/:folderUrn', async (req, res) => {
    const token = req.cookies.access_token;
    const { projectId, folderUrn } = req.params;
    try {
        const response = await axios.get(`https://developer.api.autodesk.com/data/v1/projects/${projectId}/folders/${folderUrn}/contents`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error obteniendo contenido de carpeta:', error.response?.data || error.message);
        res.status(500).json({ error: 'No se pudieron obtener contenidos de la carpeta' });
    }
});


const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});


// MODEL
app.get('/api/token', (req, res) => {
    const token = req.cookies.access_token;
    if (token) {
        res.json({
            access_token: token,
            expires_in: 3600
        });
    } else {
        res.status(401).json({ error: 'No authenticated' });
    }
});


app.post('/api/translate', async (req, res) => {
    const token = req.cookies.access_token;
    const { urn } = req.query;

    if (!urn) {
        return res.status(400).json({ error: 'Falta URN' });
    }

    const encodedUrn = Buffer.from(urn).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    try {
        const jobPayload = {
            input: { urn: encodedUrn },
            output: { formats: [{ type: 'svf', views: ['3d'] }] }
        };

        const response = await axios.post(
            'https://developer.api.autodesk.com/modelderivative/v2/designdata/job',
            jobPayload,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json(response.data);
    } catch (error) {
        console.error('Error enviando job de derivación:', error.response?.data || error.message);
        res.status(500).json({ error: 'Error enviando job de derivación' });
    }
});