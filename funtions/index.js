const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
setGlobalOptions({ region: 'asia-southeast2', maxInstances: 10 });

const db = getFirestore();
const auth = getAuth();
const ADMIN_EMAIL = 'admin@auth.absensipro.local';

function requireAuth(request) {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Anda harus login terlebih dahulu.');
  }
  return request.auth.uid;
}

async function requireAdmin(uid) {
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists || snap.data().role !== 'admin') {
    throw new HttpsError('permission-denied', 'Hanya Administrator yang dapat melakukan tindakan ini.');
  }
  return snap.data();
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function authEmailFromUsername(username) {
  return normalizeUsername(username) + '@auth.absensipro.local';
}

function cleanPayload(payload = {}) {
  return {
    username: normalizeUsername(payload.username),
    name: String(payload.name || '').trim(),
    password: String(payload.password || ''),
    nik: String(payload.nik || '').trim(),
    department: String(payload.department || '').trim(),
    position: String(payload.position || '').trim(),
    phone: String(payload.phone || '').trim(),
    email: String(payload.email || '').trim()
  };
}

exports.adminCreateEmployee = onCall(async (request) => {
  const uid = requireAuth(request);
  await requireAdmin(uid);
  const p = cleanPayload(request.data);

  if (!p.username || !p.name || !p.nik || !p.password) {
    throw new HttpsError('invalid-argument', 'Username, nama, NIK, dan password wajib diisi.');
  }
  if (!/^[a-z0-9._-]{3,40}$/.test(p.username)) {
    throw new HttpsError('invalid-argument', 'Username hanya boleh berisi huruf kecil, angka, titik, garis bawah, atau tanda minus.');
  }
  if (p.password.length < 6) {
    throw new HttpsError('invalid-argument', 'Password minimal 6 karakter.');
  }

  const [usernameSnap, nikSnap] = await Promise.all([
    db.collection('users').where('username', '==', p.username).limit(1).get(),
    db.collection('users').where('nik', '==', p.nik).limit(1).get()
  ]);

  if (!usernameSnap.empty) throw new HttpsError('already-exists', 'Username sudah digunakan.');
  if (!nikSnap.empty) throw new HttpsError('already-exists', 'NIK sudah digunakan.');

  const authEmail = authEmailFromUsername(p.username);
  let createdUser = null;

  try {
    createdUser = await auth.createUser({
      email: authEmail,
      password: p.password,
      displayName: p.name,
      disabled: false
    });

    const now = new Date().toISOString();
    const userRecord = {
      id: createdUser.uid,
      role: 'employee',
      username: p.username,
      authEmail,
      name: p.name,
      nik: p.nik,
      department: p.department,
      position: p.position,
      phone: p.phone,
      email: p.email,
      active: true,
      createdAt: now.slice(0, 10),
      updatedAt: now
    };

    const batch = db.batch();
    batch.set(db.doc(`users/${createdUser.uid}`), userRecord);
    batch.set(db.doc(`directory/${createdUser.uid}`), {
      id: createdUser.uid,
      name: p.name,
      nik: p.nik,
      department: p.department,
      position: p.position,
      active: true,
      role: 'employee',
      updatedAt: now
    });
    await batch.commit();

    return { ok: true, uid: createdUser.uid };
  } catch (error) {
    if (createdUser?.uid) {
      try { await auth.deleteUser(createdUser.uid); } catch (_) {}
    }
    if (error instanceof HttpsError) throw error;
    console.error(error);
    throw new HttpsError('internal', error?.message || 'Gagal membuat akun karyawan.');
  }
});

exports.adminSetEmployeePassword = onCall(async (request) => {
  const callerUid = requireAuth(request);
  await requireAdmin(callerUid);

  const targetUid = String(request.data?.uid || '').trim();
  const newPassword = String(request.data?.newPassword || '');
  const allowAdminSelf = request.data?.allowAdminSelf === true;

  if (!targetUid || newPassword.length < 6) {
    throw new HttpsError('invalid-argument', 'UID akun dan password minimal 6 karakter wajib diisi.');
  }

  const targetSnap = await db.doc(`users/${targetUid}`).get();
  if (!targetSnap.exists) throw new HttpsError('not-found', 'Akun tidak ditemukan.');
  const target = targetSnap.data();

  if (target.role === 'admin' && targetUid !== callerUid) {
    throw new HttpsError('permission-denied', 'Password Administrator lain tidak dapat diubah.');
  }
  if (target.role === 'admin' && !allowAdminSelf && targetUid === callerUid) {
    throw new HttpsError('permission-denied', 'Perubahan password Administrator tidak diizinkan pada konteks ini.');
  }

  await auth.updateUser(targetUid, { password: newPassword });
  await db.doc(`users/${targetUid}`).set({ updatedAt: new Date().toISOString() }, { merge: true });
  return { ok: true };
});

exports.adminDeleteEmployee = onCall(async (request) => {
  const callerUid = requireAuth(request);
  await requireAdmin(callerUid);

  const targetUid = String(request.data?.uid || '').trim();
  if (!targetUid) throw new HttpsError('invalid-argument', 'UID karyawan wajib diisi.');

  const targetSnap = await db.doc(`users/${targetUid}`).get();
  if (!targetSnap.exists) throw new HttpsError('not-found', 'Akun tidak ditemukan.');
  if (targetSnap.data().role === 'admin') {
    throw new HttpsError('failed-precondition', 'Akun Administrator tidak dapat dihapus melalui menu ini.');
  }

  const [lessonsSnap, attendanceSnap, substitutionsSnap] = await Promise.all([
    db.collection('lessons').where('teacherId', '==', targetUid).get(),
    db.collection('attendance').where('userId', '==', targetUid).get(),
    db.collection('substitutions').where('substituteTeacherId', '==', targetUid).get()
  ]);

  const originalSubstitutionsSnap = await db.collection('substitutions').where('originalTeacherId', '==', targetUid).get();

  const allSubDocs = new Map();
  substitutionsSnap.docs.forEach(d => allSubDocs.set(d.id, d));
  originalSubstitutionsSnap.docs.forEach(d => allSubDocs.set(d.id, d));

  const refs = [
    db.doc(`users/${targetUid}`),
    db.doc(`directory/${targetUid}`),
    ...lessonsSnap.docs.map(d => d.ref),
    ...attendanceSnap.docs.map(d => d.ref),
    ...Array.from(allSubDocs.values(), d => d.ref)
  ];

  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    refs.slice(i, i + 400).forEach(ref => batch.delete(ref));
    await batch.commit();
  }

  try { await auth.deleteUser(targetUid); } catch (error) {
    console.error('Auth delete failed after Firestore cleanup:', error);
    throw new HttpsError('internal', 'Data Firestore sudah dibersihkan, tetapi akun Authentication gagal dihapus.');
  }

  return { ok: true };
});

exports.adminResetSystem = onCall(async (request) => {
  const callerUid = requireAuth(request);
  await requireAdmin(callerUid);

  const [usersSnap, directorySnap, lessonsSnap, attendanceSnap, substitutionsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('directory').get(),
    db.collection('lessons').get(),
    db.collection('attendance').get(),
    db.collection('substitutions').get()
  ]);

  const refsToDelete = [];
  usersSnap.docs.forEach(d => { if (d.id !== callerUid && d.data().role !== 'admin') refsToDelete.push(d.ref); });
  directorySnap.docs.forEach(d => { if (d.id !== callerUid && d.data().role !== 'admin') refsToDelete.push(d.ref); });
  lessonsSnap.docs.forEach(d => refsToDelete.push(d.ref));
  attendanceSnap.docs.forEach(d => refsToDelete.push(d.ref));
  substitutionsSnap.docs.forEach(d => refsToDelete.push(d.ref));

  for (let i = 0; i < refsToDelete.length; i += 400) {
    const batch = db.batch();
    refsToDelete.slice(i, i + 400).forEach(ref => batch.delete(ref));
    await batch.commit();
  }

  const employeeAuthUsers = await auth.listUsers(1000);
  const employeeUids = employeeAuthUsers.users
    .filter(u => u.uid !== callerUid && u.email !== ADMIN_EMAIL)
    .map(u => u.uid);

  for (let i = 0; i < employeeUids.length; i += 1000) {
    await auth.deleteUsers(employeeUids.slice(i, i + 1000));
  }

  await db.doc('settings/main').set({
    company: 'AbsensiPro Company',
    lat: -6.2,
    lng: 106.816666,
    radius: 200,
    requireLocation: true,
    graceMinutes: 10,
    updatedAt: new Date().toISOString(),
    updatedBy: callerUid,
    resetAt: FieldValue.serverTimestamp()
  }, { merge: false });

  return { ok: true };
});
