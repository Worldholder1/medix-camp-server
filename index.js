const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const Stripe = require("stripe")

const app = express();
const port = process.env.PORT || 5000;

// Load environment variables from .env file
dotenv.config();

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Stripe with your secret key
const stripe = Stripe(process.env.STRIPE_SECRET_KEY)

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.j1rskl2.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("medixCampDB");
    const usersCollection = db.collection("users");
    const campsCollection = db.collection("camps");
    const registrationsCollection = db.collection("registrations");
    const paymentsCollection = db.collection("payments");
    const feedbacksCollection = db.collection("feedbacks");

    // ====================================================================
    // User Related APIs
    // ====================================================================

    // Get all users or a specific user by email
    app.get("/users", async (req, res) => {
      const email = req.query.email
      if (email) {
        const query = { email: email }
        const user = await usersCollection.findOne(query)
        if (!user) return res.status(404).send({ message: "User not found" })
        return res.send(user)
      }
      const result = await usersCollection.find().toArray()
      res.send(result)
    })

    // Get a single user by email (for client-side hooks)
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email
      const query = { email: email }
      const user = await usersCollection.findOne(query)
      res.send(user)
    })

    // Create a new user (on registration/login)
    app.post("/users", async (req, res) => {
      const user = req.body
      user.role = "user"
      user.created_at = new Date().toISOString()
      user.last_log_in = new Date().toISOString()
      const query = { email: user.email }
      const existingUser = await usersCollection.findOne(query)
      if (existingUser) {
        return res.status(409).send({ message: "User already exists", insertedId: null })
      }
      const result = await usersCollection.insertOne(user)
      res.send(result)
    })

    // Update user profile (Organizer/Participant)
    app.put("/users/:id", async (req, res) => {
      const id = req.params.id
      const { name, email, photo, phone } = req.body
      const filter = { _id: new ObjectId(id) }
      const updateDoc = {
        $set: {
          name: name,
          email: email,
          photo: photo,
          phone: phone, // Phone field included for update
        },
      }
      const result = await usersCollection.updateOne(filter, updateDoc)
      res.send(result)
    })

    // Get user role by email
    app.get("/users/role/:email", async (req, res) => {
      const email = req.params.email
      const user = await usersCollection.findOne({ email: email })
      res.send({ role: user?.role || "user" })
    })

    // ====================================================================
    // Camp Related APIs
    // ====================================================================

    //  Get all camps
    app.get("/camps", async (req, res) => {
      try {
        const result = await campsCollection.find().toArray()
        res.send(result)
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch camps", error: err })
      }
    })

    // Get a single camp by ID
    app.get("/camps/:id", async (req, res) => {
      const id = req.params.id
      try {
        const query = { _id: new ObjectId(id) }
        const camp = await campsCollection.findOne(query)
        if (!camp) return res.status(404).send({ message: "Camp not found" })
        res.send(camp)
      } catch (err) {
        res.status(500).send({ message: "Error fetching camp", error: err })
      }
    })

    // Add a new camp (Organizer)
    app.post("/camps", async (req, res) => {
      const camp = req.body
      if (!camp.title || !camp.date || !camp.time || !camp.images?.length) {
        return res.status(400).send({ message: "Missing required fields" })
      }
      camp.createdAt = new Date().toISOString() // Add creation timestamp
      const result = await campsCollection.insertOne(camp)
      res.send(result)
    })

    // Update a camp (Organizer)
    app.put("/camps/:id", async (req, res) => {
      const id = req.params.id
      const updatedCamp = req.body
      const filter = { _id: new ObjectId(id) }
      const options = { upsert: true }
      const updateDoc = {
        $set: {
          ...updatedCamp,
        },
      }
      try {
        const result = await campsCollection.updateOne(filter, updateDoc, options)
        if (result.modifiedCount === 0) {
          return res.status(404).send({ message: "Camp not found or no changes made" })
        }
        res.send({ message: "Camp updated successfully", modifiedCount: result.modifiedCount })
      } catch (error) {
        res.status(500).send({ message: "Failed to update camp", error })
      }
    })

    // Delete a camp (Organizer)
    app.delete("/camps/:id", async (req, res) => {
      const id = req.params.id
      const query = { _id: new ObjectId(id) }
      try {
        const result = await campsCollection.deleteOne(query)
        if (result.deletedCount === 0) {
          return res.status(404).send({ message: "Camp not found" })
        }
        // Also delete associated registrations for the deleted camp
        await registrationsCollection.deleteMany({ camp_id: id })
        res.send({ message: "Camp and associated registrations deleted successfully" })
      } catch (error) {
        res.status(500).send({ message: "Failed to delete camp", error })
      }
    })


    // ====================================================================
    // Registration Related APIs
    // ====================================================================

    // Get all registrations or by participant email
    app.get("/registrations", async (req, res) => {
      const email = req.query.email;
      try {
        const filter = email ? { participantEmail: email } : {}; // ✅ corrected field name
        const result = await registrationsCollection.find(filter).toArray();
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch registrations", error: err });
      }
    });

    // Get registrations by camp ID (for organizers to manage registered camps)
    app.get("/registrations/camp/:campId", async (req, res) => {
      const campId = req.params.campId
      const query = { camp_id: campId }
      const result = await registrationsCollection.find(query).toArray()
      res.send(result)
    })

    // Add a new registration
    app.post("/registrations", async (req, res) => {
      const registration = req.body
      registration.paymentStatus = "unpaid"
      registration.confirmationStatus = "pending"
      registration.createdAt = new Date().toISOString() // Add creation timestamp
      try {
        const insertResult = await registrationsCollection.insertOne(registration)
        // Increment participant count in the corresponding camp
        const updateResult = await campsCollection.updateOne(
          { _id: new ObjectId(registration.camp_id) },
          { $inc: { participant_count: 1 } },
        )
        res.send({
          registrationId: insertResult.insertedId,
          updatedCount: updateResult.modifiedCount,
        })
      } catch (error) {
        res.status(500).send({ message: "Failed to register", error })
      }
    })

    // ✅ ADDED: Get a single registration by ID
    app.get("/registrations/:id", async (req, res) => {
      const id = req.params.id;
      try {
        const result = await registrationsCollection.findOne({ _id: new ObjectId(id) });
        if (!result) return res.status(404).send({ message: "Registration not found" });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch registration", error: err });
      }
    });

    // Update registration status (e.g., confirmed, cancelled)
    app.patch("/registrations/:id", async (req, res) => {
      const id = req.params.id
      const { status } = req.body
      const filter = { _id: new ObjectId(id) }
      const updateDoc = {
        $set: {
          status: status,
        },
      }
      const result = await registrationsCollection.updateOne(filter, updateDoc)
      res.send(result)
    })

    // Delete a registration
    app.delete("/registrations/:id", async (req, res) => {
      const id = req.params.id
      const query = { _id: new ObjectId(id) }
      const registration = await registrationsCollection.findOne(query)
      const result = await registrationsCollection.deleteOne(query)

      // Decrement participant_count in camps collection if registration was deleted
      if (result.deletedCount > 0 && registration) {
        const campId = registration.camp_id
        await campsCollection.updateOne({ _id: new ObjectId(campId) }, { $inc: { participant_count: -1 } })
      }
      res.send(result)
    })

    // ====================================================================
    // Payment Related APIs
    // ====================================================================

    // Get all payments or by participant email
    app.get("/payments", async (req, res) => {
      const email = req.query.email
      if (email) {
        const query = { participantEmail: email }
        const result = await paymentsCollection.find(query).toArray()
        return res.send(result)
      }
      const result = await paymentsCollection.find().toArray()
      res.send(result)
    })

    // ✅ ADDED: Update payment info for a registration
    app.patch("/registrations/:id/payment", async (req, res) => {
      const id = req.params.id;
      const paymentInfo = req.body;

      try {
        // ✅ Validate incoming data
        if (!paymentInfo.transactionId || !paymentInfo.paymentStatus || !paymentInfo.paymentDate) {
          return res.status(400).send({ message: "Missing required payment info" });
        }

        // ✅ Update registration document with payment info
        const registrationUpdateResult = await registrationsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              paymentStatus: paymentInfo.paymentStatus,
              transactionId: paymentInfo.transactionId,
              paymentDate: paymentInfo.paymentDate,
              confirmationStatus: "confirmed",
            },
          }
        );

        // ✅ Fetch full registration info (needed for payment doc)
        const registration = await registrationsCollection.findOne({ _id: new ObjectId(id) });

        if (!registration) {
          return res.status(404).send({ message: "Registration not found for payment insertion" });
        }

        // ✅ Construct full payment document
        const fullPaymentDoc = {
          participantEmail: registration.participantEmail,
          campName: registration.campName,
          amount: registration.campFees || paymentInfo.amount || 0,
          paymentStatus: paymentInfo.paymentStatus,
          confirmationStatus: "confirmed",
          transactionId: paymentInfo.transactionId,
          paymentDate: paymentInfo.paymentDate,
        };

        // ✅ Insert into payments collection
        const paymentInsertResult = await paymentsCollection.insertOne(fullPaymentDoc);

        // ✅ Promote user to participant if still "user"
        const user = await usersCollection.findOne({ email: registration.participantEmail });
        if (user && user.role === "user") {
          await usersCollection.updateOne(
            { email: registration.participantEmail },
            { $set: { role: "participant" } }
          );
        }

        // ✅ Respond with both update and insert results
        res.send({
          message: "Payment recorded successfully",
          registrationUpdate: registrationUpdateResult,
          paymentInsert: paymentInsertResult,
        });
      } catch (err) {
        console.error("❌ Failed to update payment and insert into payments:", err);
        res.status(500).send({ message: "Failed to update payment", error: err });
      }
    });



    app.post("/create-payment-intent", async (req, res) => {
      const { amount } = req.body;
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount, // amount in cents
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        res.status(500).send({ message: "Failed to create payment intent", error: err });
      }
    });


    // Add a new payment
    app.post("/payments", async (req, res) => {
      const payment = req.body
      const result = await paymentsCollection.insertOne(payment)
      res.send(result)
    })

    




    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);


app.get("/", (req, res) => {
  res.send("Medix Camp server is running");
});

app.listen(port, () => {
  console.log(` Server listening on port ${port}`);
});