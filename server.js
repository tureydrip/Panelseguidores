const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// === CREDENCIALES Y CONFIGURACIÓN ===
// ¡API Key actualizada!
const API_KEY = process.env.SMM_API_KEY || "sk_live_24900f5bf10de994fb512e18192c617d2183ce183a82d444";
const SMM_URL = "https://smmzing.com/api/v3";
const FIREBASE_DB_URL = "https://loginhackstore-default-rtdb.firebaseio.com";
const PROFIT_MARGIN = 1.20; // 20% de ganancia

// ==========================================
// 1. RUTA CLÁSICA (COMPRAS DIRECTAS)
// ==========================================
app.post('/api/smm', async (req, res) => {
    try {
        const { action, ...extraParams } = req.body;
        if (!action) return res.status(400).json({ error: "La acción es requerida" });

        const params = new URLSearchParams();
        params.append('key', API_KEY);
        params.append('action', action); // Ya no forzamos multi_status a status, SMMZing lo soporta

        for (const [key, value] of Object.entries(extraParams)) {
            params.append(key, value);
        }

        const response = await fetch(SMM_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });

        res.json(await response.json());
    } catch (error) {
        console.error("Error en /api/smm:", error);
        res.status(500).json({ error: "Error de conexión interna" });
    }
});

// ==========================================
// 2. NUEVA RUTA: API PARA REVENDEDORES (100% COMPATIBLE)
// ==========================================
app.post('/api/v1/reseller', async (req, res) => {
    try {
        const { key, action, service, link, quantity, order, orders } = req.body;
        
        if (!key || !key.startsWith('luck_')) {
            return res.status(401).json({ error: "Invalid API Key format" });
        }

        const uid = key.split('_')[1];

        const userRes = await fetch(`${FIREBASE_DB_URL}/users/${uid}.json`);
        const userData = await userRes.json();

        if (!userData || userData.apiKey !== key) {
            return res.status(401).json({ error: "Unauthorized API Key" });
        }

        // --- ACCIÓN: BALANCE ---
        if (action === 'balance') {
            return res.json({ balance: parseFloat(userData.balance || 0).toFixed(4), currency: "USD" });
        }

        // --- ACCIÓN: SERVICIOS ---
        if (action === 'services') {
            const smmRes = await fetch(SMM_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ key: API_KEY, action: 'services' })
            });
            const services = await smmRes.json();
            
            const markedUpServices = services.map(s => ({
                ...s,
                rate: (parseFloat(s.rate) * PROFIT_MARGIN).toFixed(4)
            }));
            
            return res.json(markedUpServices);
        }

        // --- ACCIÓN: CREAR ORDEN (ADD) ---
        if (action === 'add') {
            if (!service || !link || !quantity) return res.status(400).json({ error: "Missing parameters: service, link, quantity required" });
            
            const smmRes = await fetch(SMM_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ key: API_KEY, action: 'services' })
            });
            const services = await smmRes.json();
            
            const targetService = services.find(s => s.service == service);
            if (!targetService) return res.status(400).json({ error: "Invalid service ID" });

            const unitPrice = parseFloat(targetService.rate) * PROFIT_MARGIN;
            const totalCost = (unitPrice / 1000) * parseInt(quantity);
            const userBalance = parseFloat(userData.balance || 0);

            if (userBalance < totalCost) {
                return res.status(400).json({ error: "Insufficient balance in your account" });
            }

            const addRes = await fetch(SMM_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ key: API_KEY, action: 'add', service, link, quantity })
            });
            const addData = await addRes.json();

            if (addData.order) {
                const newBalance = userBalance - totalCost;
                await fetch(`${FIREBASE_DB_URL}/users/${uid}.json`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ balance: newBalance })
                });
                
                const historyEntry = {
                    type: 'smm', 
                    smmOrderId: addData.order, 
                    serviceName: `(API) ${targetService.name}`,
                    link: link, 
                    quantity: parseInt(quantity), 
                    price: totalCost,
                    date: Date.now(), 
                    smmStatus: 'Pending', 
                    refunded: false
                };

                await fetch(`${FIREBASE_DB_URL}/users/${uid}/history.json`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(historyEntry)
                });

                return res.json({ order: addData.order });
            } else {
                return res.status(400).json(addData);
            }
        }

        // --- ACCIÓN: STATUS ---
        if (action === 'status') {
            if (!order) return res.status(400).json({ error: "Missing order ID" });
            
            const statusRes = await fetch(SMM_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ key: API_KEY, action: 'status', order })
            });
            
            return res.json(await statusRes.json());
        }

        // --- NUEVA ACCIÓN: MULTI STATUS ---
        if (action === 'multi_status') {
            if (!orders) return res.status(400).json({ error: "Missing orders parameter (comma separated IDs)" });
            
            const msRes = await fetch(SMM_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ key: API_KEY, action: 'multi_status', orders })
            });
            return res.json(await msRes.json());
        }

        // --- NUEVAS ACCIONES: REFILL, REFILL_STATUS, CANCEL ---
        if (['refill', 'refill_status', 'cancel'].includes(action)) {
            if (!order) return res.status(400).json({ error: "Missing order ID" });
            
            const extraActionRes = await fetch(SMM_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ key: API_KEY, action: action, order })
            });
            return res.json(await extraActionRes.json());
        }

        return res.status(400).json({ error: "Invalid action" });

    } catch (err) {
        console.error("API Reseller Error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ==========================================
// 3. FUNCIÓN DE SINCRONIZACIÓN (BLINDADA - INDIVIDUAL)
// ==========================================
async function syncAllSmmOrders() {
    console.log('[CRON] Iniciando sincronización automática de pedidos SMM...');
    let updatesCount = 0;
    let refundsCount = 0;

    try {
        const usersRes = await fetch(`${FIREBASE_DB_URL}/users.json`);
        const users = await usersRes.json();
        
        if (!users) {
            console.log('[CRON] No hay usuarios en la base de datos.');
            return { updatesCount, refundsCount, status: 'No users' };
        }

        for (const [uid, userData] of Object.entries(users)) {
            if (!userData.history) continue;

            for (const [historyKey, order] of Object.entries(userData.history)) {
                if (order.type === 'smm' && order.smmOrderId && !order.refunded) {
                    const status = (order.smmStatus || 'pending').toLowerCase();
                    
                    if (status !== 'completed' && status !== 'canceled' && status !== 'partial') {
                        try {
                            const params = new URLSearchParams();
                            params.append('key', API_KEY);
                            params.append('action', 'status');
                            params.append('order', order.smmOrderId);

                            const smmRes = await fetch(SMM_URL, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                body: params.toString()
                            });
                            
                            const apiData = await smmRes.json();

                            if (apiData && apiData.status && !apiData.error) {
                                const newStatus = apiData.status;
                                const statusLower = newStatus.toLowerCase();
                                const isCanceled = (statusLower === 'canceled' || statusLower === 'error');

                                const historyUpdate = { smmStatus: newStatus };
                                if (isCanceled) historyUpdate.refunded = true;

                                await fetch(`${FIREBASE_DB_URL}/users/${uid}/history/${historyKey}.json`, {
                                    method: 'PATCH',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify(historyUpdate)
                                });
                                updatesCount++;

                                if (isCanceled) {
                                    const freshUserRes = await fetch(`${FIREBASE_DB_URL}/users/${uid}.json`);
                                    const freshUserData = await freshUserRes.json();
                                    const updatedBalance = parseFloat(freshUserData.balance || 0) + parseFloat(order.price || 0);

                                    await fetch(`${FIREBASE_DB_URL}/users/${uid}.json`, {
                                        method: 'PATCH',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ balance: updatedBalance })
                                    });
                                    refundsCount++;
                                    console.log(`[CRON] Reembolso de $${order.price} aplicado a UID: ${uid}`);
                                }
                            }
                        } catch (smmError) {
                            console.error(`[CRON] Error al consultar orden #${order.smmOrderId}:`, smmError);
                        }
                    }
                }
            }
        }
        
        console.log(`[CRON] Sincronización finalizada. Actualizados: ${updatesCount} | Reembolsos: ${refundsCount}`);
        return { updatesCount, refundsCount, status: 'Success' };

    } catch (error) {
        console.error('[CRON] Error crítico general en la sincronización:', error);
        return { error: error.message };
    }
}

// ==========================================
// 4. PROGRAMACIÓN DEL CRON JOB (Cada 10 mins)
// ==========================================
cron.schedule('*/10 * * * *', () => {
    syncAllSmmOrders();
});

// ==========================================
// 5. RUTA SECRETA PARA FORZAR EL CRON MANUALMENTE
// ==========================================
app.get('/api/force-cron', async (req, res) => {
    console.log('[MANUAL] Se ha forzado la ejecución del Cron desde la URL');
    const result = await syncAllSmmOrders();
    res.json({ message: "Sincronización forzada completada", result });
});

// === MANEJO DE RUTAS DEL FRONTEND ===
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Backend de LUCK XIT activo en el puerto ${PORT}`);
});
