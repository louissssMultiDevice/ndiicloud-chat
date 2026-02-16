// /api/auth/verify.js
import { kv } from '@vercel/kv';

const ADMIN_SECRET = '#6287717274346';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { phone, email, code, adminCode } = req.body;
    
    // Admin verification
    if (adminCode === ADMIN_SECRET) {
      const sessionId = generateSessionId();
      await kv.set(`session:${sessionId}`, JSON.stringify({
        id: 'admin',
        name: 'Administrator',
        role: 'admin',
        phone: '6287717274346',
        createdAt: Date.now()
      }), { ex: 86400 });
      
      return res.json({
        success: true,
        isAdmin: true,
        sessionId,
        user: {
          id: 'admin',
          name: 'Administrator',
          role: 'admin'
        }
      });
    }
    
    // Regular OTP verification
    const target = phone || email;
    const otpData = await kv.get(`otp:${target}`);
    
    if (!otpData) {
      return res.status(400).json({ error: 'OTP not found or expired' });
    }
    
    const otp = typeof otpData === 'string' ? JSON.parse(otpData) : otpData;
    
    if (otp.expires < Date.now()) {
      await kv.del(`otp:${target}`);
      return res.status(400).json({ error: 'OTP expired' });
    }
    
    if (otp.code !== code) {
      otp.attempts++;
      await kv.set(`otp:${target}`, JSON.stringify(otp), { ex: 300 });
      return res.status(400).json({ error: 'Invalid code' });
    }
    
    // Success - create session
    await kv.del(`otp:${target}`);
    const sessionId = generateSessionId();
    const userData = {
      id: generateId(),
      name: target,
      phone: phone || null,
      email: email || null,
      role: 'user',
      createdAt: Date.now()
    };
    
    await kv.set(`session:${sessionId}`, JSON.stringify(userData), { ex: 86400 });
    await kv.set(`user:${target}`, JSON.stringify(userData));
    
    return res.json({
      success: true,
      sessionId,
      user: userData
    });
    
  } catch (error) {
    console.error('Verify Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function generateSessionId() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function generateId() {
  return Math.random().toString(36).substring(2, 15);
}
