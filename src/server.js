import express from 'express'
import { createServer } from 'http'
import cors from 'cors'
import helmet from 'helmet'
import dotenv from 'dotenv'
import { connectDB } from './configs/mongodb.js'
import { router as apiRoutes } from './routes/index.js'
import { router as ownerCompatRoutes } from './routes/ownerCompat.js'
import { processExpiredIngredientLots } from './modules/ingredients/inventoryLifecycle.js'
import { processDueReservationInventory } from './modules/orders/orderController.js'
import { initIngredientSocket } from './realtime/ingredientSocket.js'
import { initTableOrderSocket } from './realtime/tableOrderSocket.js'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 5001
const server = createServer(app)

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'https://spc-owner.vercel.app',
  'https://spc-customer.vercel.app',
  'https://sp-spin3-frontend.vercel.app',
]

const isAllowedDevOrigin = (origin) => {
  if (process.env.NODE_ENV !== 'development') return false

  try {
    const { hostname } = new URL(origin)
    return hostname === 'localhost' || hostname === '127.0.0.1'
  } catch {
    return false
  }
}

app.use(helmet())
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || isAllowedDevOrigin(origin)) {
      return callback(null, true)
    }

    return callback(new Error(`Not allowed by CORS: ${origin}`))
  },
  credentials: true,
}))
app.use(express.json({ limit: '5mb' }))
app.use('/api', ownerCompatRoutes)
app.use('/api', apiRoutes)

await connectDB()
initIngredientSocket(server)
initTableOrderSocket(server)

const sweepExpiredIngredientLots = async () => {
  try {
    await processExpiredIngredientLots()
  } catch (err) {
    console.error('Expired ingredient sweep failed:', err.message)
  }
}

const sweepDueReservationInventory = async () => {
  try {
    const result = await processDueReservationInventory()
    if (result.deductedCount > 0) {
      console.log(`Deducted inventory for ${result.deductedCount} due reservation order(s)`)
    }
    if (result.errors.length > 0) {
      console.error('Due reservation inventory errors:', result.errors)
    }
  } catch (err) {
    console.error('Due reservation inventory sweep failed:', err.message)
  }
}

await sweepExpiredIngredientLots()
await sweepDueReservationInventory()
setInterval(sweepExpiredIngredientLots, 10 * 60 * 1000)
setInterval(sweepDueReservationInventory, 10 * 60 * 1000)

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
