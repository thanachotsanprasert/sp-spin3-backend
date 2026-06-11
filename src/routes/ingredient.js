import { Router } from 'express';
import {
  getAllIngredients,
  getIngredientsByStatus,
  getIngredient,
  updateIngredient,
  updateIngredientStock,
  decreaseIngredientStock,
  createIngredient,
  getIngredientLots,
  addIngredientStock,
  expireIngredientLot,
  updateIngredientLot,
  deleteIngredientLot,
} from '../modules/ingredients/ingredientController.js';
import { isAuth, isEligible } from '../middleware/auth.js';
import { sseHandler } from '../utils/sse.js';

export const router = Router();

const kitchenStockAccess = [isAuth, isEligible('owner', 'cook')];

// SSE Stream
router.get('/stream', sseHandler);

// GET all ingredients
router.get('/', kitchenStockAccess, getAllIngredients);

// GET batches for an ingredient
router.get('/:id/batches', kitchenStockAccess, getIngredientLots);

// POST add stock batch (increment)
router.post('/:id/stock', kitchenStockAccess, addIngredientStock);

// PUT expire a specific lot
router.put('/:id/lots/:lotId/expire', kitchenStockAccess, expireIngredientLot);

// PUT update a specific lot (direct edit)
router.put('/:id/lots/:lotId', kitchenStockAccess, updateIngredientLot);

// DELETE a specific lot
router.delete('/:id/lots/:lotId', kitchenStockAccess, deleteIngredientLot);

router.delete('/:id', kitchenStockAccess, async (req, res) => {
  try {
    const { Ingredient } = await import('../modules/ingredients/Ingredient.js')
    const ingredient = await Ingredient.findByIdAndUpdate(
      req.params.id,
      { active_status: false },
      { new: true }
    )
    if (!ingredient) return res.status(404).json({ message: 'Ingredient not found' })
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// GET ingredients grouped by status (in_stock, low_stock, out_of_stock) - COOK BOARD
router.get('/status/board', kitchenStockAccess, getIngredientsByStatus);

// GET single ingredient
router.get('/:id', kitchenStockAccess, getIngredient);

// POST create ingredient
router.post('/', kitchenStockAccess, createIngredient);

// PUT update ingredient details
router.put('/:id', kitchenStockAccess, updateIngredient);

// PUT update ingredient stock (set exact quantity)
router.put('/:id/stock', kitchenStockAccess, updateIngredientStock);

// PUT decrease ingredient stock (used when cooking)
router.put('/:id/decrease', kitchenStockAccess, decreaseIngredientStock);
