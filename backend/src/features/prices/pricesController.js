import { PriceAdministrationError} from "./pricesError.js";

export function createPricesController(service){
return {
    async listPrices(req, res) {
        res.set("Cache-Control", "no-store");
        try{
            const data = await service.listPrices();
            res.status(200).json({success: true, data});
        }catch{
            console.error("Price read failed");
            res.status(500).json({
                success: false,
                code: "PRICE_READ_FAILED",
                error: "There was an internal error while fetching prices",
            })
            }
         },

         async updatePrice(req, res){
            res.set("Cache-Control", "no-store")
            try{
                const actorRequest = {
                    ...req,
                    body: req.body,
                    user: req.staffActor ?? req.user,
                }
                const data = await service.setPrice(req.body, actorRequest);
                res.status(200).json({success: true, data })
            }catch(error){
                if(error instanceof PriceAdministrationError){
                    return res.status(error.status).json({
                        success:false,
                        code:error.code,
                        error: error.message,
                    })
                }
                

                if(
                    ["23505", "23514", "40P01", "55P03", "40001"].includes(error?.code)
                ){
                    return res.status(409).json({
                        success: false,
                        code: "PRICE_CONFLICT",
                        error: "Price update conflicted with concurrent operation. Retry",

                    })
                }
                console.error("Price update failed")
                res.status(500).json({
                    success: false,
                    code: "PRICE_UPDATE_FAILED",
                    error: "Price update could not be completed. Retry",

                })
            }
        },
            }
        }
        