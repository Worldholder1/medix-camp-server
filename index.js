const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express();
const port = process.env.PORT || 5000;

// Load environment variables from .env file
dotenv.config();

// Middleware
app.use(cors());
app.use(express.json());

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

    // POST /camps
    app.post("/camps", async (req, res) => {
      const camp = req.body;

      if (!camp.title || !camp.date || !camp.time || !camp.images?.length) {
        return res.status(400).send({ message: "Missing required fields" });
      }

      camp.createdAt = new Date().toISOString();
      const result = await campsCollection.insertOne(camp);
      res.send(result);
    });

    // GET /camps - list all camps
    app.get("/camps", async (req, res) => {
      try {
        const camps = await campsCollection.find().toArray();
        res.send(camps);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch camps", error: err });
      }
    });

    // single camp get method

    app.get("/camps/:id", async (req, res) => {
      const id = req.params.id;
      try {
        const camp = await campsCollection.findOne({ _id: new ObjectId(id) });
        if (!camp) return res.status(404).send({ message: "Camp not found" });
        res.send(camp);
      } catch (err) {
        res.status(500).send({ message: "Error fetching camp", error: err });
      }
    });

    // PUT /camps/:id - Update a camp
    app.put("/camps/:id", async (req, res) => {
      const id = req.params.id
      const updatedCamp = req.body
      try {
        const result = await campsCollection.updateOne({ _id: new ObjectId(id) }, { $set: updatedCamp })
        if (result.modifiedCount === 0) {
          return res.status(404).send({ message: "Camp not found or no changes made" })
        }
        res.send({ message: "Camp updated successfully", modifiedCount: result.modifiedCount })
      } catch (error) {
        res.status(500).send({ message: "Failed to update camp", error })
      }
    })

    // DELETE /camps/:id - Delete a camp
    app.delete("/camps/:id", async (req, res) => {
      const id = req.params.id
      try {
        const result = await campsCollection.deleteOne({ _id: new ObjectId(id) })
        if (result.deletedCount === 0) {
          return res.status(404).send({ message: "Camp not found" })
        }
        // Also delete associated registrations
        await registrationsCollection.deleteMany({ campId: id })
        res.send({ message: "Camp and associated registrations deleted successfully" })
      } catch (error) {
        res.status(500).send({ message: "Failed to delete camp", error })
      }
    })

    // ================= REGISTRATIONS =================
    // app/post methode for joincamp registration
    app.post("/registrations", async (req, res) => {
      const registration = req.body;
      registration.paymentStatus = "unpaid";
      registration.confirmationStatus = "pending";
      registration.createdAt = new Date().toISOString();

      try {
        const insertResult = await registrationsCollection.insertOne(registration);

        // Increment participant count
        const updateResult = await campsCollection.updateOne(
          { _id: new ObjectId(registration.campId) },
          { $inc: { participant_count: 1 } }
        );

        res.send({
          registrationId: insertResult.insertedId,
          updatedCount: updateResult.modifiedCount,
        });
      } catch (error) {
        res.status(500).send({ message: "Failed to register", error });
      }
    });

    // app/get methode for joincamp registration

    app.get("/registrations", async (req, res) => {
      const { email } = req.query;
      try {
        const filter = email ? { participantEmail: email } : {};
        const result = await registrationsCollection.find(filter).toArray();
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch registrations", error: err });
      }
    });


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