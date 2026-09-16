const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
setGlobalOptions({ region: 'asia-southeast2', maxInstances: 5 });

const db = admin.firestore();
const auth = admin.auth();
const AUTH_DOMAIN_SUFFIX = '@auth.absensipro.local';
const DEFAULT_SETTINGS = {
  company:'AbsensiPro Company',lat:-6.200000,lng:106.816666,radius:200,
  requireLocation:true,graceMinutes:10
};

async function requireAdmin(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Anda harus login.');
  if (request.auth.token.admin === true) return true;
  const snap = await db.doc(`users/${request.auth.uid}`).get();
  if (!snap.exists || snap.data().role !== 'admin' || snap.data().active !== true) {
    throw new HttpsError('permission-denied', 'Hanya Administrator yang boleh melakukan tindakan ini.');
  }
  return true;
}

function authEmail(username) {
  return String(username || '').trim().toLowerCase() + AUTH_DOMAIN_SUFFIX;
}

async function deleteDocsInBatches(refs, chunkSize = 450) {
  for (let i = 0; i < refs.length; i += chunkSize) {
    const batch = db.batch();
    refs.slice(i, i + chunkSize).forEach(ref => batch.delete(ref));
    await batch.commit();
  }
}

async function collectQueryRefs(query) {
  const snap = await query.get();
  return snap.docs.map(d => d.ref);
}

async function createEmployeeForAdmin(d) {
  for (const f of ['username','name','password','nik']) {
    if (!d[f]) throw new HttpsError('invalid-argument', `Field ${f} wajib diisi.`);
  }
  if (String(d.password).length < 6) throw new HttpsError('invalid-argument','Password minimal 6 karakter.');
  const username = String(d.username).trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw new HttpsError('invalid-argument','Username hanya boleh berisi huruf, angka, titik, underscore, atau tanda minus.');
  }
  const email = authEmail(username);
  let userRecord;
  try {
    userRecord = await auth.createUser({ email, password: String(d.password), displayName: String(d.name) });
  } catch (e) {
    if (e.code === 'auth/email-already-exists') throw new HttpsError('already-exists','Username tersebut sudah memiliki akun Firebase.');
    throw new HttpsError('internal', e.message || 'Gagal membuat akun Firebase.');
  }
  const user = {
    id:userRecord.uid, role:'employee', username, authEmail:email, name:String(d.name), nik:String(d.nik),
    department:String(d.department||''), position:String(d.position||''), phone:String(d.phone||''),
    email:String(d.email||''), active:true, createdAt:new Date().toISOString()
  };
  try {
    await Promise.all([
      db.doc(`users/${userRecord.uid}`).set(user),
      db.doc(`directory/${userRecord.uid}`).set({id:userRecord.uid,name:user.name,nik:user.nik,department:user.department,position:user.position,active:true,role:'employee'})
    ]);
    return { uid:userRecord.uid };
  } catch (e) {
    await auth.deleteUser(userRecord.uid).catch(()=>{});
    throw new HttpsError('internal', e.message || 'Gagal menyimpan profil karyawan.');
  }
}

// HTTP endpoint used by the browser so GitHub Pages preflight/CORS is handled explicitly.
exports.adminCreateEmployee = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed', message: 'Gunakan POST.' });

  try {
    const authHeader = String(req.headers.authorization || '');
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'unauthenticated', message: 'Authorization Bearer token wajib dikirim.' });
    }
    const idToken = authHeader.slice(7).trim();
    const decoded = await auth.verifyIdToken(idToken);
    const fakeRequest = { auth: { uid: decoded.uid, token: decoded }, data: req.body || {} };
    await requireAdmin(fakeRequest);
    const result = await createEmployeeForAdmin(req.body || {});
    return res.status(200).json(result);
  } catch (e) {
    const code = e instanceof HttpsError ? e.code : 'internal';
    const message = e.message || 'Terjadi kesalahan pada server.';
    const statusMap = {
      'unauthenticated': 401, 'permission-denied': 403, 'invalid-argument': 400,
      'already-exists': 409, 'failed-precondition': 412, 'not-found': 404
    };
    const status = statusMap[code] || 500;
    console.error('adminCreateEmployee failed:', e);
    return res.status(status).json({ error: code, message });
  }
});

exports.adminSetEmployeePassword = onCall(async request => {
  await requireAdmin(request);
  const d=request.data||{};
  if (!d.uid || !d.newPassword) throw new HttpsError('invalid-argument','UID dan password baru wajib diisi.');
  if (String(d.newPassword).length < 6) throw new HttpsError('invalid-argument','Password minimal 6 karakter.');
  try { await auth.updateUser(String(d.uid), { password:String(d.newPassword) }); }
  catch(e) { throw new HttpsError('internal', e.message || 'Gagal mengubah password.'); }
  return {ok:true};
});

exports.adminDeleteEmployee = onCall(async request => {
  await requireAdmin(request);
  const uid=String(request.data?.uid||'');
  if (!uid) throw new HttpsError('invalid-argument','UID karyawan wajib diisi.');
  if (uid===request.auth.uid) throw new HttpsError('failed-precondition','Administrator tidak dapat menghapus akun yang sedang digunakan.');

  const refs=[];
  refs.push(db.doc(`users/${uid}`), db.doc(`directory/${uid}`));
  refs.push(...await collectQueryRefs(db.collection('attendance').where('userId','==',uid)));
  refs.push(...await collectQueryRefs(db.collection('lessons').where('teacherId','==',uid)));
  refs.push(...await collectQueryRefs(db.collection('substitutions').where('originalTeacherId','==',uid)));
  refs.push(...await collectQueryRefs(db.collection('substitutions').where('substituteTeacherId','==',uid)));
  await deleteDocsInBatches(refs);
  await auth.deleteUser(uid);
  return {ok:true};
});

exports.adminResetSystem = onCall(async request => {
  await requireAdmin(request);
  const keepUid=request.auth.uid;
  const [users, lessons, attendance, substitutions, directory] = await Promise.all([
    db.collection('users').get(), db.collection('lessons').get(), db.collection('attendance').get(),
    db.collection('substitutions').get(), db.collection('directory').get()
  ]);
  const refs=[];
  lessons.docs.forEach(s=>refs.push(s.ref));
  attendance.docs.forEach(s=>refs.push(s.ref));
  substitutions.docs.forEach(s=>refs.push(s.ref));
  directory.docs.filter(s=>s.id!==keepUid).forEach(s=>refs.push(s.ref));
  users.docs.filter(s=>s.id!==keepUid).forEach(s=>refs.push(s.ref));
  refs.push(db.doc('settings/main'));
  await deleteDocsInBatches(refs);

  let nextPageToken;
  do {
    const page=await auth.listUsers(1000,nextPageToken);
    const ids=page.users.filter(u=>u.uid!==keepUid).map(u=>u.uid);
    for(let i=0;i<ids.length;i+=1000) await auth.deleteUsers(ids.slice(i,i+1000));
    nextPageToken=page.pageToken;
  } while(nextPageToken);

  await db.doc(`users/${keepUid}`).set({
    role:'admin',username:'admin',name:'Administrator Utama',nik:'ADM-001',department:'Administrator',
    position:'System Administrator',active:true,updatedAt:new Date().toISOString()
  },{merge:true});
  await db.doc(`directory/${keepUid}`).set({
    id:keepUid,name:'Administrator Utama',nik:'ADM-001',department:'Administrator',
    position:'System Administrator',active:true,role:'admin'
  },{merge:true});
  await db.doc('settings/main').set({...DEFAULT_SETTINGS,updatedAt:new Date().toISOString(),updatedBy:keepUid});
  return {ok:true};
});
