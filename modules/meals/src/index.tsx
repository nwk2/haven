import { Navigate, Route, Routes } from "react-router-dom";
import { Ctx, type ModuleCtx } from "./ctx";
import { Ingredients } from "./Ingredients";
import { Plan } from "./Plan";
import { RecipeDetail, Recipes } from "./Recipes";
import { RecipeEditor } from "./RecipeEditor";
import { Shopping } from "./Shopping";

/** Meals & Groceries, mounted by the shell under /m/meals/* (Technical spec › Module contract). */
export default function MealsModule({ ctx }: { ctx: ModuleCtx }) {
  return (
    <Ctx.Provider value={ctx}>
      <Routes>
        <Route path="plan" element={<Plan />} />
        <Route path="recipes" element={<Recipes />} />
        <Route path="recipes/new" element={<RecipeEditor />} />
        <Route path="recipes/:id" element={<RecipeDetail />} />
        <Route path="recipes/:id/edit" element={<RecipeEditor />} />
        <Route path="ingredients" element={<Ingredients />} />
        <Route path="lists" element={<Shopping />} />
        <Route path="*" element={<Navigate to="plan" replace />} />
      </Routes>
    </Ctx.Provider>
  );
}
export type { ModuleCtx };
