import { registerSeatRoutes } from "./src/features/seats/seatsRoutes.js";
import { registerScreeningRoutes } from "./src/features/screenings/screeningsRoutes.js";

export default function(app, pool) {



    registerSeatRoutes(app, pool);

//get all screens
    app.get('/api/screens', async (req, res) => {
        try{
            const cityId = req.query.cityId;
            let query = `
            SELECT screens.id,
            screens.capacity,
            screens.wheelchair_capacity,
            screens.city_id,
            cities.name AS city_name
            FROM screens
            JOIN cities ON screens.city_id = cities.id
            `;


            let params = [];
            if(cityId){
                query += ` WHERE screens.city_id = $1`
                params.push(cityId)}
            
                query += ` ORDER BY screens.id ASC`

                    const queryResult = await pool.query(query, params)
            res.status(200).json({success: true, data: queryResult.rows})
        }catch(error){
            console.error('Error while fetching screens')
            res.status(500).json({success: false, error: 'There was an internal error while fetching screens'})
        }
    })

    //Get screen by id

    app.get('/api/screens/:id', async (req, res) =>{
        try{
            const id = req.params.id;
            //const cityId = req.query.cityId
            let query = await pool.query(`
                SELECT screens.id,
                screens.capacity,
                screens.wheelchair_capacity,
                screens.city_id,
                cities.name AS city_name
                FROM screens
                JOIN cities ON screens.city_id = cities.id
                WHERE screens.id = $1`, [id]);

            if(query.rows.length === 0){
                return res.status(404).json({success: false, error: 'Screen not found'})
            }

            res.status(200).json({success: true, data: query.rows[0]})
        }catch(error){
            console.error('There was error while fetching screen')
            res.status(500).json({success: false, error: 'There was an inside error while fetching screen'})
        }
    })




    //GET ALL FILMS

    app.get('/api/films', async (req, res)=>{
        try{
            const result = await pool.query('SELECT * FROM films')
            res.status(200).json({success: true, data: result.rows})
        }catch(error){
            res.status(500).json({success: false, error: 'There was a inside error while fetching films'})
        }
    })

    //GET FILM BY ID 

    app.get('/api/films/:id', async (req, res)=>{
        try{

            const idToSearch = req.params.id;

            const queryResult = await pool.query(`
                SELECT * 
                FROM films
                WHERE films.id = $1`, [idToSearch] )

                if(queryResult.rows.length === 0){
                    return res.status(404).json({success: false, error: 'Film not found'})
                }

                res.status(200).json({success: true, data: queryResult.rows[0]})

        }catch(error){
            console.error('There was an inside error while fetching the film')
            res.status(500).json({success: false, error: ' There was an inside error while fetching film'})
        }
    })
    

    //GET CITIEES

    app.get('/api/cities', async (req, res) => {
        try{
            const cities = await pool.query(`SELECT * FROM cities`)
            if(cities.rows.length == 0){
                return res.status(404).json({success: false, error: 'No cities found'})
            }
            const result = cities.rows

            res.status(200).json({success: true, data: result})

        }catch(error){
            console.error('There was an inside error while fetching cities')
            res.status(500).json({success: false, error: 'There was an inside error while fetching cities'})
        }

    })
    
    //GET CITY BY ID

    app.get('/api/cities/:id', async (req, res) => {
        try{
        const cityIdToFind = req.params.id;

        const queryResult = await pool.query('SELECT * FROM cities WHERE id = $1', [cityIdToFind])

        if(queryResult.rows.length == 0){
           return res.status(404).json({success: false, error: 'City not found'})
        }

            res.status(200).json({success: true, data: queryResult.rows[0] })
    }catch(error){
            console.error('There was an inside error while fetching cities')
            res.status(500).json({success: false, error: 'There was an inside error while fetching cities'})
    }

    })

    // Screening reads are composed in the screenings feature.
    registerScreeningRoutes(app, pool);

    // GET PRICES

    app.get('/api/prices', async (req, res) => {

       try{
         const priceQueryResult = await pool.query(`SELECT * FROM prices`)

        res.status(200).json({success: true, data: priceQueryResult.rows})
       }catch(error){
        console.error('There was an inside error while fetching prices')
        res.status(500).json({success: false, error: 'There was an inside error while fetching prices'})
       }

    })

    
// GET BOOKINGS

    app.get('/api/bookings', async (req, res) => {
        try{
        const screeningId = req.query.screeningId;

        let query = `
        SELECT
        bookings.id AS booking_id,
        screenings.screening_time,
        films.title AS film_title,
        ARRAY_AGG(tickets.seat_id) AS seat_id
        FROM bookings
        JOIN screenings ON bookings.screening_id  = screenings.id
        JOIN films ON screenings.film_id = films.id
        LEFT JOIN tickets ON tickets.booking_id = bookings.id
         `

         let params = [];

         if(screeningId){
            query += ` WHERE bookings.screening_id = $1`;
            params.push(screeningId);
         }

         query += ` GROUP BY bookings.id, screenings.screening_time, films.title`;

         query += ` ORDER BY bookings.id DESC`;

         const result = await pool.query(query, params);

            res.status(200).json({
                success: true,
                data: result.rows
            })

        }catch(error){
            console.log('Error while fetching bookings', error)
            res.status(500).json({success: false, error: 'an internal error while fetching bookings'})
        }


    })


//delete booking
app.delete('/api/bookings/:id', async (req, res)=>{
    const client = await pool.connect();
    try{
        const bookingId = req.params.id;

        const checkBookingId = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId])
        if(checkBookingId.rows.length === 0){
            client.release();
            return res.status(404).json({success: false, error: 'Booking not found'})
        }
    
        await client.query('BEGIN');
        await client.query('DELETE FROM tickets WHERE booking_id = $1', [bookingId])
        await client.query('DELETE FROM bookings WHERE id = $1', [bookingId])
        await client.query('COMMIT'); client.release();

        res.status(200).json({success: true, message: `Booking with id of: ${bookingId} deleted`})
    }catch(error){
        await client.query('ROLLBACK');
        client.release();

        res.status(500).json({success: false, error: 'There was an internal error while deleting booking'})
    }
})

//post booking
app.post('/api/bookings', async (req, res)=>{
    const client = await pool.connect();
    try{
        const screeningId = req.body.screeningId
        const seatId = req.body.seatId
        const clientEmail = req.body.clientEmail || 'test@client.com'

        if(!screeningId || !seatId || !Array.isArray(seatId) || seatId.length === 0 ){
            client.release();
            return res.status(400).json({success: false, error: 'ScreeningId and seatId array is required'})
        }

        await client.query('BEGIN')

        const seatIdsOnly = seatId.map(s => typeof s === 'object' ? s.seatId : s)

        const checkExistingTickets = await client.query(`
            SELECT
            tickets.seat_id
            FROM tickets
            JOIN bookings ON tickets.booking_id = bookings.id 
            WHERE bookings.screening_id = $1 AND tickets.seat_id = ANY($2::int[])
            `, [screeningId, seatIdsOnly])


            if (checkExistingTickets.rows.length > 0){
               await client.query('ROLLBACK')
               client.release();
               return res.status(400).json({
                success: false,
                error: 'Some of the seats are reserved'
               })
            }

            const pricesResult = await client.query(`
                SELECT  
                category,
                amount_cents
                FROM prices
                `)
            
            if(pricesResult.rows.length === 0){
                await client.query('ROLLBACK')
                client.release()
                return res.status(400).json({
                    success: false,
                     error: 'Base price is not configured in the base'})
            }

          const priceMap = {};
          pricesResult.rows.forEach(row => {
            priceMap[row.category.toLowerCase()] = row.amount_cents
          })
                
          const adultPrice = priceMap['adult']

            const bookingResult = await client.query(`
            INSERT INTO bookings (screening_id, status, booking_time, guest_email)
            VALUES ($1, 'paid', NOW(), $2)
            RETURNING id, screening_id
            `, [screeningId, clientEmail])
           
            const newBooking = bookingResult.rows[0]
            const createdTickets = [];

           for(const item of seatId){
            const currentSeatId = typeof item === 'object' ? item.seatId : item;
            const category = (typeof item === 'object' && item.category) ? item.category.toLowerCase(): 'adult';
           

           if(!['adult', 'child', 'company'].includes(category)){
            await client.query('ROLLBACK');
            client.release();
            return res.status(400).json({success: false, error: ` Invalid ticket category`})
           }

        let ticketPrice = priceMap[category]
        if(ticketPrice === undefined){
            if(category === 'child'){
                ticketPrice = Math.round(adultPrice * 0.5)
            }else{
                await client.query('ROLLBACK');
                client.release();
                return res.status(400).json({success: false, error: `Price for category ${category} is not found`})
            }
        }

        await client.query(`
            INSERT INTO tickets (booking_id, seat_id, amount_charged)
            VALUES ($1, $2, $3)
            `, [newBooking.id, currentSeatId, ticketPrice])

            createdTickets.push({
                seatId: currentSeatId,
                category,
                amountCharged: ticketPrice
            })
           }

            await client.query('COMMIT')
            client.release()

            res.status(201).json({
                success: true, data:{
                    bookingId: newBooking.id, 
                    screeningid: newBooking.screening_id, 
                    tickets: createdTickets
                    }})

    }catch(error){
        await client.query('ROLLBACK');
        client.release();
        console.error('There was an inside error while posting a new booking', error)
        res.status(500).json({success: false, error: 'There was internal error while creating booking'})
}
})
}

