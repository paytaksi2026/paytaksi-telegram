
import express from "express";
import { q } from "./db.js";

const router = express.Router();

router.post("/api/driver/register", async (req,res)=>{
  try{
    const {
      driverId,
      fullName,
      phone,
      carModel,
      carPlate,
      carColor,
      licenseNumber,
      licensePhoto,
      carPhoto
    } = req.body;

    await q(`INSERT INTO driver_profiles(
      driver_id, full_name, phone, car_model, car_plate, car_color,
      license_number, license_photo, car_photo, created_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT(driver_id) DO UPDATE SET
      full_name=$2, phone=$3, car_model=$4, car_plate=$5,
      car_color=$6, license_number=$7, license_photo=$8,
      car_photo=$9`,
    [driverId, fullName, phone, carModel, carPlate, carColor,
     licenseNumber, licensePhoto, carPhoto, Date.now()]);

    res.json({ ok:true });

  }catch(e){
    res.json({ ok:false, error:e.message });
  }
});

router.get("/api/driver/status/:id", async (req,res)=>{
  try{
    const r = await q("SELECT status, approved, rejected_reason FROM driver_profiles WHERE driver_id=$1",[req.params.id]);
    if(!r.rows[0]) return res.json({ ok:false, status:"NONE", approved:false });
    const row = r.rows[0];
    res.json({ ok:true, status: row.status || (row.approved ? "APPROVED" : "PENDING"), approved: !!row.approved, rejectedReason: row.rejected_reason || "" });
  }catch(e){
    res.json({ ok:false, status:"ERR" });
  }
});
    res.json({ ok:true, approved:r.rows[0].approved });
  }catch(e){
    res.json({ ok:false });
  }
});

router.post("/api/admin/driver/approve", async (req,res)=>{
  try{
    const { driverId } = req.body;
    await q("UPDATE driver_profiles SET approved=true, status='APPROVED', rejected_reason=NULL WHERE driver_id=$1",[driverId]);
    res.json({ ok:true });
  }catch(e){
    res.json({ ok:false });
  }
});

router.get("/api/admin/drivers", async (req,res)=>{
  try{
    const r = await q("SELECT * FROM driver_profiles ORDER BY created_at DESC");
    res.json({ ok:true, drivers:r.rows });
  }catch(e){
    res.json({ ok:false });
  }
});

router.post("/api/admin/driver/reject", async (req,res)=>{
  try{
    const { driverId, reason } = req.body || {};
    const r = String(reason||"").slice(0, 300);
    await q("UPDATE driver_profiles SET approved=false, status='REJECTED', rejected_reason=$2 WHERE driver_id=$1",[driverId, r]);
    res.json({ ok:true });
  }catch(e){
    res.json({ ok:false, error:e.message });
  }
});

export default router;
