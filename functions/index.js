const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { logger } = require('firebase-functions');
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
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Anda harus login terlebih dahulu.');
  }

  // Prefer the custom claim when present.
  if (request.auth.token?.admin === true) return true;

  // Fall back to the authoritative Firestore admin profile.
  try {
    const snap = await db.doc(`users/${request.auth.uid}`).get();
    const data = snap.exists ? snap.data() : null;

    if (!data || data.role !== 'admin' || data.active !== true) {
      throw new HttpsError(
        'permission-denied',
        'Akun yang sedang login bukan Administrator aktif.'
      );
    }
  } catch (error) {
    if (error instanceof HttpsError) throw error;

    logger.error('requireAdmin Firestore check failed', {
      uid: request.auth.uid,
      code: error?.code,
      message: error?.message,
      stack: error?.stack,
    });

    throw new HttpsError(
      'internal',
      'Gagal memverifikasi hak Administrator. Periksa deployment Cloud Functions dan Firestore.'
    );
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

exports.adminCreateEmployee = onCall(
  { region: 'asia-southeast2', timeoutSeconds: 60, memory: '256MiB' },
  async request => {
    await requireAdmin(request);

    const d = request.data || {};
    for (const f of ['username', 'name', 'password', 'nik']) {
      if (typeof d[f] !== 'string' || !d[f].trim()) {
        throw new HttpsError('invalid-argument', `Field ${f} wajib diisi.`);
      }
    }

    const username = String(d.username).trim().toLowerCase();
    const name = String(d.name).trim();
    const password = String(d.password);
    const nik = String(d.nik).trim();

    if (password.length < 6) {
      throw new HttpsError('invalid-argument', 'Password minimal 6 karakter.');
    }

    if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
      throw new HttpsError(
        'invalid-argument',
        'Username hanya boleh berisi huruf, angka, titik, underscore, atau tanda minus.'
      );
    }

    const email = authEmail(username);
    let userRecord = null;

    // Check first so we can return a clean message instead of an opaque internal error.
    try {
      try {
        await auth.getUserByEmail(email);
        throw new HttpsError(
          'already-exists',
          `Username "${username}" sudah memiliki akun Firebase.`
        );
      } catch (error) {
        if (error instanceof HttpsError) throw error;
        if (error?.code !== 'auth/user-not-found') throw error;
      }

      userRecord = await auth.createUser({
        email,
        password,
        displayName: name,
        disabled: false,
      });
    } catch (error) {
      if (error instanceof HttpsError) throw error;

      logger.error('adminCreateEmployee Auth create failed', {
        adminUid: request.auth?.uid,
        username,
        email,
        code: error?.code,
        message: error?.message,
        stack: error?.stack,
      });

      const code = error?.code || '';
      if (code === 'auth/email-already-exists') {
        throw new HttpsError(
          'already-exists',
          `Username "${username}" sudah memiliki akun Firebase.`
        );
      }
      if (code === 'auth/invalid-email') {
        throw new HttpsError(
          'invalid-argument',
          `Alamat internal untuk username "${username}" ditolak oleh Firebase Authentication: ${email}.`
        );
      }
      if (code === 'auth/invalid-password' || code === 'auth/password-does-not-meet-requirements') {
        throw new HttpsError(
          'invalid-argument',
          'Password tidak memenuhi persyaratan Firebase Authentication.'
        );
      }
      if (code === 'auth/operation-not-allowed') {
        throw new HttpsError(
          'failed-precondition',
          'Firebase Authentication Email/Password belum diaktifkan pada project ini.'
        );
      }
      if (code === 'auth/insufficient-permission') {
        throw new HttpsError(
          'permission-denied',
          'Cloud Functions tidak memiliki izin untuk mengelola Firebase Authentication.'
        );
      }

      throw new HttpsError(
        'internal',
        `Gagal membuat akun Firebase untuk "${username}".${error?.message ? ` Detail: ${error.message}` : ''}`
      );
    }

    const user = {
      id: userRecord.uid,
      role: 'employee',
      username,
      authEmail: email,
      name,
      nik,
      department: String(d.department || '').trim(),
      position: String(d.position || '').trim(),
      phone: String(d.phone || '').trim(),
      email: String(d.email || '').trim(),
      active: true,
      createdAt: new Date().toISOString(),
    };

    try {
      await db.doc(`users/${userRecord.uid}`).set(user);
      await db.doc(`directory/${userRecord.uid}`).set({
        id: userRecord.uid,
        name: user.name,
        nik: user.nik,
        department: user.department,
        position: user.position,
        active: true,
        role: 'employee',
      });

      logger.info('adminCreateEmployee success', {
        adminUid: request.auth?.uid,
        employeeUid: userRecord.uid,
        username,
      });

      return { ok: true, uid: userRecord.uid };
    } catch (error) {
      logger.error('adminCreateEmployee Firestore write failed', {
        adminUid: request.auth?.uid,
        employeeUid: userRecord.uid,
        username,
        code: error?.code,
        message: error?.message,
        stack: error?.stack,
      });

      // Roll back the Authentication account so we never leave an orphan account.
      await auth.deleteUser(userRecord.uid).catch(rollbackError => {
        logger.error('adminCreateEmployee rollback failed', {
          employeeUid: userRecord.uid,
          code: rollbackError?.code,
          message: rollbackError?.message,
        });
      });

      throw new HttpsError(
        'internal',
        `Akun Firebase berhasil dibuat tetapi data karyawan gagal disimpan ke Firestore.${error?.message ? ` Detail: ${error.message}` : ''}`
      );
    }
  }
);

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
