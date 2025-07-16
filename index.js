const dotenv = require('dotenv');

const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const Stripe = require("stripe")

const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 5000;

// Load environment variables from .env file
dotenv.config();

// Middleware
app.use(cors());
app.use(express.json());




const decodedKey = Buffer.from(process.env.FB_SERVICE_KEYS, 'base64').toString('utf8');
const serviceAccount = JSON.parse(decodedKey);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// const serviceAccount = require("./firebase-admin-key.json");

// admin.initializeApp({
//     credential: admin.credential.cert(serviceAccount)
// });


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
    // await client.connect();

    const db = client.db("medixCampDB");
    const usersCollection = db.collection("users");
    const campsCollection = db.collection("camps");

    await campsCollection.updateMany(
      { participant_count: { $exists: false } },
      { $set: { participant_count: 0 } }
    );


    const registrationsCollection = db.collection("registrations");
    const paymentsCollection = db.collection("payments");
    const feedbacksCollection = db.collection("feedbacks");


    // custom middlewares
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: 'unauthorized access' })
      }
      const token = authHeader.split(' ')[1];
      if (!token) {
        return res.status(401).send({ message: 'unauthorized access' })
      }

      // verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      }
      catch (error) {
        return res.status(403).send({ message: 'forbidden access' })
      }
    }

    // Add this role-check middleware below your verifyFBToken middleware
    const verifyOrganizer = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email: email.toLowerCase() });
      if (user?.role !== 'organizer') {
        return res.status(403).send({ message: "Forbidden: Organizer only" });
      }
      next();
    };


    // ====================================================================
    // User Related APIs
    // ====================================================================

    // Get all users or a specific user by email
    app.get("/users", verifyFBToken, async (req, res) => {
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
    app.get("/users/:email", verifyFBToken, async (req, res) => {
      const email = req.params.email
      const query = { email: email }
      const user = await usersCollection.findOne(query)
      res.send(user)
    })

    // Create a new user (on registration/login)
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.email = user.email.toLowerCase();  // **Normalize email to lowercase here**
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
    app.patch("/users/:email", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const { name, photo, phone } = req.body;

      if (!name && !photo && !phone) {
        return res.status(400).send({ message: "No update data provided" });
      }

      try {
        const filter = { email };
        const updateDoc = { $set: {} };

        if (name) updateDoc.$set.name = name;
        if (photo) updateDoc.$set.photo = photo;
        if (phone) updateDoc.$set.phone = phone;

        const result = await usersCollection.updateOne(filter, updateDoc);
        const updatedUser = await usersCollection.findOne(filter);

        if (!updatedUser) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send({
          message:
            result.modifiedCount > 0
              ? "Profile updated successfully"
              : "No changes made, but profile is valid",
          user: updatedUser,
        });
      } catch (error) {
        console.error("❌ Error updating profile:", error);
        res.status(500).send({ message: "Failed to update profile", error });
      }
    });

    // Get user role by email
    app.get("/users/role/:email", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({
        email: { $regex: `^${email}$`, $options: "i" }
      });
      res.send({ role: user?.role || "user" });
    });

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

    app.post("/camps", verifyFBToken, verifyOrganizer, async (req, res) => {
      const camp = req.body;

      if (!camp.title || !camp.date || !camp.time || !camp.images?.length) {
        return res.status(400).send({ message: "Missing required fields" });
      }

      camp.createdAt = new Date().toISOString(); // Timestamp
      camp.participant_count = 0; // Required for count increment to work

      try {
        const result = await campsCollection.insertOne(camp);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to add camp", error });
      }
    });

    // Update a camp (Organizer)
    app.put("/camps/:id", verifyFBToken, verifyOrganizer, async (req, res) => {
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
    app.delete("/camps/:id", verifyFBToken, verifyOrganizer, async (req, res) => {
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
    app.get("/registrations", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      try {
        const filter = email ? { participantEmail: email } : {};
        const result = await registrationsCollection.find(filter).toArray();
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch registrations", error: err });
      }
    });

    // Get registrations by camp ID (for organizers to manage registered camps)
    app.get("/registrations/camps/:campId", verifyFBToken, verifyOrganizer, async (req, res) => {
      const campId = req.params.campId
      const query = { camp_id: campId }
      const result = await registrationsCollection.find(query).toArray()
      res.send(result)
    })

    app.post("/registrations", verifyFBToken, async (req, res) => {
      const registration = req.body;
      registration.paymentStatus = "unpaid";
      registration.confirmationStatus = "pending";
      registration.createdAt = new Date().toISOString();

      try {
        const insertResult = await registrationsCollection.insertOne(registration);

        //  Use registration.campId (not camp_id) and cast to ObjectId
        const updateResult = await campsCollection.updateOne(
          { _id: new ObjectId(registration.campId) },
          { $inc: { participant_count: 1 } }
        );

        res.send({
          registrationId: insertResult.insertedId,
          updatedCount: updateResult.modifiedCount,
        });
      } catch (error) {
        console.error("❌ Registration error:", error);
        res.status(500).send({ message: "Failed to register", error });
      }
    });

    //  Get a single registration by ID
    app.get("/registrations/:id", verifyFBToken, async (req, res) => {
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
    app.patch("/registrations/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const { confirmationStatus } = req.body;

      const filter = { _id: new ObjectId(id) };
      const updateDoc = { $set: { confirmationStatus } };

      const result = await registrationsCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // Delete a registration
    app.delete("/registrations/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      try {
        const registration = await registrationsCollection.findOne(query);
        if (!registration) {
          return res.status(404).send({ message: "Registration not found" });
        }

        const deleteResult = await registrationsCollection.deleteOne(query);

        if (deleteResult.deletedCount > 0) {
          const campId = registration.campId || registration.camp_id; // ensure field matches your schema

          try {
            await campsCollection.updateOne(
              { _id: new ObjectId(campId) },
              { $inc: { participant_count: -1 } }
            );
          } catch (err) {
            console.error("Failed to decrement participant count:", err);
            // You can choose to continue or return error here
          }

          return res.send({
            message: "Registration deleted and participant count updated",
            deletedCount: deleteResult.deletedCount,
          });
        } else {
          return res.status(400).send({ message: "Failed to delete registration" });
        }
      } catch (error) {
        console.error("Error deleting registration:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // ====================================================================
    // Payment Related APIs
    // ====================================================================

    // Get all payments or by participant email
    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email
      if (email) {
        const query = { participantEmail: email }
        const result = await paymentsCollection.find(query).toArray()
        return res.send(result)
      }
      const result = await paymentsCollection.find().toArray()
      res.send(result)
    })

    // Update payment info for a registration
    app.patch("/registrations/:id/payment", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const { transactionId, paymentStatus, paymentDate, amount } = req.body;

      if (!transactionId || !paymentStatus || !paymentDate) {
        return res.status(400).send({ message: "Missing required payment info" });
      }

      try {
        // Update registration
        const registrationUpdate = await registrationsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              paymentStatus,
              transactionId,
              paymentDate,
              confirmationStatus: "confirmed",
            },
          }
        );

        //  Fetch updated registration
        const registration = await registrationsCollection.findOne({ _id: new ObjectId(id) });
        if (!registration) return res.status(404).send({ message: "Registration not found" });

        //  Insert payment record
        const paymentDoc = {
          participantEmail: registration.participantEmail,
          campName: registration.campName,
          amount: registration.campFees || amount || 0,
          paymentStatus,
          confirmationStatus: "confirmed",
          transactionId,
          paymentDate,
        };
        const paymentInsert = await paymentsCollection.insertOne(paymentDoc);

        //  Update user role to "participant" — always
        const roleUpdate = await usersCollection.updateOne(
          { email: { $regex: `^${registration.participantEmail}$`, $options: "i" } },
          { $set: { role: "participant" } }
        );

        res.send({
          message: "Payment and role update successful",
          registrationUpdate,
          paymentInsert,
          roleUpdate,
        });
      } catch (error) {
        console.error("❌ Payment update failed:", error);
        res.status(500).send({ message: "Payment update failed", error });
      }
    });



    app.post("/create-payment-intent", async (req, res) => {
      const { amount } = req.body;
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        res.status(500).send({ message: "Failed to create payment intent", error: err });
      }
    });


    // Add a new payment
    app.post("/payments", verifyFBToken, async (req, res) => {
      const payment = req.body
      const result = await paymentsCollection.insertOne(payment)
      res.send(result)
    })

    // ====================================================================
    // Feedback Related APIs
    // ====================================================================

    // Get all feedbacks or by camp ID
    app.get("/feedbacks", async (req, res) => {
      const campId = req.query.campId
      if (campId) {
        const query = { camp_id: campId }
        const result = await feedbacksCollection.find(query).toArray()
        return res.send(result)
      }
      const result = await feedbacksCollection.find().toArray()
      res.send(result)
    })

    // Add new feedback
    app.post("/feedbacks", verifyFBToken, async (req, res) => {
      const feedback = req.body
      const result = await feedbacksCollection.insertOne(feedback)
      res.send(result)
    })

    // ====================================================================
    // Analytics Related APIs
    // ====================================================================

    // Analytics API (Example - can be expanded)
    app.get("/analytics/dashboard", verifyFBToken, async (req, res) => {
      const totalUsers = await usersCollection.countDocuments()
      const totalCamps = await campsCollection.countDocuments()
      const totalRegistrations = await registrationsCollection.countDocuments()
      const totalRevenue = await paymentsCollection
        .aggregate([
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" },
            },
          },
        ])
        .toArray()

      res.send({
        totalUsers,
        totalCamps,
        totalRegistrations,
        totalRevenue: totalRevenue.length > 0 ? totalRevenue[0].total : 0,
      })
    })

    // Example: Get total number of registered camps
    app.get("/analytics/registered-camps-count", verifyFBToken, async (req, res) => {
      const count = await registrationsCollection.countDocuments()
      res.send({ count })
    })






    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log("Pinged your deployment. You successfully connected to MongoDB!");
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
    console.log(`Server is listening on port ${port}`);
});