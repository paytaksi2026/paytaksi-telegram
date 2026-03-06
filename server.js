
/*
ADD THIS BLOCK INTO server.js
Driver rating API (additive, does not remove existing logic)
*/

app.post('/api/driver/rate', async (req,res)=>{
 try{

   const {driver,rating} = req.body;

   await db.query(`
     INSERT INTO driver_ratings(driver_phone,rating)
     VALUES($1,$2)
   `,[driver,rating]);

   await db.query(`
     UPDATE drivers
     SET rating = (
       SELECT ROUND(AVG(rating),2)
       FROM driver_ratings
       WHERE driver_phone=$1
     )
     WHERE phone=$1
   `,[driver]);

   res.json({success:true});

 }catch(e){
   res.json({success:false});
 }
});
